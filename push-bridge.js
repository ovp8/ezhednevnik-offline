/* push-bridge.js — мост между «Ежедневником» и Web Push API браузера.
 *
 * Подключается из index.html. Никак не влияет на работу приложения:
 * при недоступности Service Worker / Notification API просто тихо завершается.
 *
 * Регистрирует /sw.js и экспортирует window.fletPush для push-setup.html:
 *   fletPush.subscribe(vapidPublicKey) -> PushSubscription (и POST на сервер)
 *   fletPush.unsubscribe()             -> true/false
 *   fletPush.status()                  -> {supported, permission, subscribed}
 */
(async function () {
  'use strict';

  if (typeof window === 'undefined') return;

  const SUBSCRIBE_URL = '/api/push/subscribe';
  const UNSUBSCRIBE_URL = '/api/push/unsubscribe';
  const VAPID_URL = '/api/push/vapid_public_key';
  const TZ_URL = '/api/push/report_tz';

  const urlBase64ToUint8Array = (base64String) => {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const output = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
    return output;
  };

  const getUidFromUrl = () => {
    try {
      return new URLSearchParams(window.location.search).get('uid') || '';
    } catch (e) {
      return '';
    }
  };

  const sendToServer = async (url, payload) => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.json().catch(() => ({}));
  };

  const registerSW = async () => {
    if (!('serviceWorker' in navigator)) return null;
    try {
      // ВАЖНО: scope '/push/' — чтобы НЕ замещать родной SW Flet на корне
      // ('/') и не перехватывать живую страницу (иначе ws-хендшейк сессии
      // ломается и приложение висит на "Working...").
      // Web Push работает и без контроля страницы: подписка создаётся
      // через registration.pushManager.subscribe().
      return await navigator.serviceWorker.register('./sw.js', { scope: './push/' });
    } catch (e) {
      console.warn('[push-bridge] SW register failed:', e);
      return null;
    }
  };

  const swReg = await registerSW();

  window.fletPush = {
    supported: !!(swReg && 'PushManager' in window && 'Notification' in window),

    async status() {
      if (!('Notification' in window)) {
        return { supported: false, permission: 'unsupported', subscribed: false };
      }
      let subscribed = false;
      try {
        if (swReg) {
          const sub = await swReg.pushManager.getSubscription();
          subscribed = !!sub;
        }
      } catch (e) { /* ignore */ }
      return {
        supported: this.supported,
        permission: Notification.permission,
        subscribed,
      };
    },

    async requestPermission() {
      if (!('Notification' in window)) return 'unsupported';
      if (Notification.permission === 'granted') return 'granted';
      try {
        return await Notification.requestPermission();
      } catch (e) {
        return 'denied';
      }
    },

    async subscribe(vapidKey) {
      if (!swReg) throw new Error('ServiceWorker недоступен');
      if (!('PushManager' in window)) throw new Error('PushManager недоступен');

      let key = vapidKey;
      if (!key) {
        const resp = await fetch(VAPID_URL);
        if (!resp.ok) throw new Error('Не удалось получить публичный ключ сервера');
        key = (await resp.json()).publicKey;
      }

      const permission = await this.requestPermission();
      if (permission !== 'granted') throw new Error('Разрешение не выдано');

      let sub = await swReg.pushManager.getSubscription();
      if (!sub) {
        sub = await swReg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key),
        });
      }

      await sendToServer(SUBSCRIBE_URL, {
        uid: getUidFromUrl(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        subscription: sub.toJSON(),
      });
      return sub;
    },

    async unsubscribe() {
      if (!swReg) return false;
      const sub = await swReg.pushManager.getSubscription();
      if (!sub) return false;
      try {
        await sendToServer(UNSUBSCRIBE_URL, { endpoint: sub.endpoint });
      } catch (e) { /* локальная отписка важнее */ }
      return sub.unsubscribe();
    },
  };


  // ===== Статическая сборка (WASM): системные уведомления из Python =====
  // Python-воркер публикует напоминание в BroadcastChannel, здесь мы
  // показываем СИСТЕМНОЕ уведомление (работает и когда PWA свёрнута) со
  // звуком. Когда PWA закрыта полностью — уведомления доставит сервер
  // через Web Push (этап 2).
  const beepTwice = () => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const t0 = ctx.currentTime;
      [[880, 0], [1318.5, 0.22]].forEach(([freq, dt]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0 + dt);
        gain.gain.exponentialRampToValueAtTime(0.28, t0 + dt + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.34);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0 + dt);
        osc.stop(t0 + dt + 0.36);
      });
      setTimeout(() => { try { ctx.close(); } catch (e) {} }, 900);
    } catch (e) { /* звук не критичен */ }
  };

  const showSystemNotification = async (title, body, extra) => {
    extra = extra || {};
    if (!('Notification' in window)) return;
    let permission = Notification.permission;
    if (permission === 'default') {
      try { permission = await Notification.requestPermission(); } catch (e) {}
    }
    if (permission !== 'granted') return;
    const options = {
      body: body || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: extra.tag || ('reminder-' + Date.now()),
      renotify: true,
      requireInteraction: false,
      silent: false,
      data: { url: extra.url || './', task_id: extra.task_id || 0 },
    };
    try {
      let reg = swReg;
      if (!reg && navigator.serviceWorker) {
        reg = await navigator.serviceWorker.getRegistration('./push/');
      }
      if (reg && reg.showNotification) {
        await reg.showNotification(title, options);
      } else {
        new Notification(title, options);
      }
    } catch (e) {
      try { new Notification(title, options); } catch (e2) {}
    }
  };

  try {
    const notifyChannel = new BroadcastChannel('ezh-notify');
    notifyChannel.onmessage = (event) => {
      let data = {};
      try {
        data = (typeof event.data === 'string') ? JSON.parse(event.data) : (event.data || {});
      } catch (e) {}
      beepTwice();
      showSystemNotification(data.title || 'Ежедневник', data.body || '', data);
    };
  } catch (e) { /* BroadcastChannel недоступен — не критично */ }

  // Автоподписка: разрешение уже выдано (например, после установки PWA),
  // а подписка исчезла/протухла — восстанавливаем молча.
  try {
    if (window.fletPush.supported && Notification.permission === 'granted') {
      const st = await window.fletPush.status();
      if (!st.subscribed) {
        await window.fletPush.subscribe(); // ключ возьмём с сервера
      }
    }
  } catch (e) {
    // сервер без /api/* (например, режим разработки) — тихо игнорируем
    console.debug('[push-bridge] autosubscribe skipped:', e && e.message);
  }
})();
