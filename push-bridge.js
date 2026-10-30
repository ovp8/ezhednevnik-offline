/* push-bridge.js — мост между «Ежедневником» и браузером (звук + уведомления).
 *
 * Подключается из index.html. Никак не влияет на работу приложения:
 * при недоступности Service Worker / Notification API просто тихо завершается.
 *
 * Что делает:
 *  1. Регистрирует ./sw.js со скоупом ./push/ (Web Push; на статическом
 *     хостинге подписка на сервер не уходит — это нормально).
 *  2. Слушает BroadcastChannel 'ezh-notify': Python-воркер (Pyodide) публикует
 *     напоминание {title, body, tag, task_id, url} — мост играет короткий
 *     сигнал (Web Audio) и показывает системное уведомление через
 *     Service Worker. Работает и когда PWA свёрнута, но ещё не выгружена.
 *  3. Экспортирует window.fletPush для push-setup.html:
 *     fletPush.subscribe(vapidPublicKey) / unsubscribe() / status().
 *
 * ФИКС ЗВУКА (iOS): AudioContext создаётся заранее и разблокируется на
 * первом касании экрана. Прежняя версия создавала контекст в момент
 * напоминания — вне жеста пользователя iOS оставлял его suspended,
 * и звук не играл вовсе.
 *
 * Все пути ОТНОСИТЕЛЬНЫЕ — работает и из корня домена, и из подпапки
 * (GitHub Pages: /ezhednevnik-offline/).
 */
(async function () {
  'use strict';

  if (typeof window === 'undefined') return;

  const SUBSCRIBE_URL = './api/push/subscribe';
  const UNSUBSCRIBE_URL = './api/push/unsubscribe';
  const VAPID_URL = './api/push/vapid_public_key';

  const NOTIFY_CHANNEL = 'ezh-notify';
  const APP_NAME = 'Ежедневник';

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
      // Скоуп ./push/ — чтобы НЕ замещать родной SW Flet (flutter_service_worker.js)
      // на корне страницы и не перехватывать живую страницу.
      // Web Push работает и без контроля страницы: подписка создаётся
      // через registration.pushManager.subscribe().
      return await navigator.serviceWorker.register('./sw.js', { scope: './push/' });
    } catch (e) {
      console.warn('[push-bridge] SW register failed:', e);
      return null;
    }
  };

  const swReg = await registerSW();

  /* ================= Звук (Web Audio) =================
   * iOS разблокирует AudioContext только в обработчике жеста пользователя.
   * Держим ОДИН живой контекст и разблокируем его на первом касании —
   * тогда к моменту напоминания (таймер вне жеста) звук уже разрешён. */

  let audioCtx = null;
  const ensureAudio = () => {
    try {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      return audioCtx;
    } catch (e) {
      return null;
    }
  };
  ['pointerdown', 'touchstart', 'keydown'].forEach((ev) =>
    window.addEventListener(ev, ensureAudio, { passive: true }));

  // Двойной «динь» (880 Гц + 1318.5 Гц) — как в будильнике
  const beepTwice = () => {
    const ctx = ensureAudio();
    if (!ctx) return;
    const run = () => {
      try {
        const t0 = ctx.currentTime + 0.03;
        [[880, 0], [1318.5, 0.22]].forEach(([freq, dt]) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, t0 + dt);
          gain.gain.exponentialRampToValueAtTime(0.28, t0 + dt + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.34);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(t0 + dt);
          osc.stop(t0 + dt + 0.36);
        });
      } catch (e) { /* звук не критичен */ }
    };
    if (ctx.state === 'running') run();
    else ctx.resume().then(run).catch(() => {});
  };

  /* ================= Системное уведомление ================= */

  const showSystemNotification = async (title, body, extra) => {
    extra = extra || {};
    try {
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
      let reg = swReg;
      if (!reg && navigator.serviceWorker) {
        reg = await navigator.serviceWorker.getRegistration('./push/');
      }
      if (reg && reg.showNotification) {
        await reg.showNotification(title || APP_NAME, options);
      } else if (typeof Notification !== 'undefined') {
        try { new Notification(title || APP_NAME, options); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  };

  /* ================= Мост из Python-воркера ================= */

  try {
    if ('BroadcastChannel' in window) {
      const notifyChannel = new BroadcastChannel(NOTIFY_CHANNEL);
      notifyChannel.onmessage = (event) => {
        let data = {};
        try {
          data = (typeof event.data === 'string')
            ? JSON.parse(event.data) : (event.data || {});
        } catch (e) {}
        beepTwice();
        showSystemNotification(data.title || APP_NAME, data.body || '', data);
      };
    }
  } catch (e) { /* BroadcastChannel недоступен — не критично */ }

  /* ================= Web Push (для серверной схемы) ================= */

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

      const permission = await this.requestPermission();
      if (permission !== 'granted') throw new Error('Разрешение не выдано');

      let sub = await swReg.pushManager.getSubscription();
      if (!sub) {
        if (!vapidKey) {
          // На статическом хостинге сервера нет — без ключа подписаться нельзя.
          throw new Error('VAPID-ключ недоступен (нужен push-сервер)');
        }
        sub = await swReg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        });
      }

      try {
        await sendToServer(SUBSCRIBE_URL, {
          uid: getUidFromUrl(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
          subscription: sub.toJSON(),
        });
      } catch (e) { /* статический хостинг: подписка остаётся локальной */ }
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

  // Автоподписка: разрешение уже выдано (например, после установки PWA),
  // а подписка исчезла/протухла — восстанавливаем молча.
  try {
    if (window.fletPush.supported && Notification.permission === 'granted') {
      const st = await window.fletPush.status();
      if (!st.subscribed) {
        // Ключ возьмём с сервера; на статике сервера нет — просто тихо выйдем.
        await window.fletPush.subscribe().catch(() => {});
      }
    }
  } catch (e) {
    // сервер без /api/* (например, режим разработки) — тихо игнорируем
    console.debug('[push-bridge] autosubscribe skipped:', e && e.message);
  }
})();
