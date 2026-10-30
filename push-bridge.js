/* push-bridge.js — мост между «Ежедневником» и браузером (звук + уведомления + push-сервер).
 *
 * Подключается из index.html (и из push-setup.html). Никак не влияет на работу
 * приложения: при недоступности Service Worker / Notification API тихо завершается.
 *
 * Что делает:
 *  1. Регистрирует ./sw.js со скоупом ./push/ (Web Push).
 *  2. Слушает BroadcastChannel 'ezh-notify': Python-воркер (Pyodide) публикует
 *     напоминание {title, body, tag, task_id, url} — мост играет короткий
 *     сигнал (Web Audio) и показывает системное уведомление. Работает, пока
 *     PWA открыта (пусть и свёрнута).
 *  3. PUSH-СЕРВЕР (напоминания при ЗАКРЫТОМ приложении):
 *     - подписка pushManager с VAPID-ключом → POST {server}/subscribe;
 *     - загрузка расписания напоминаний из локального снапшота
 *       db_snapshot_<uid> → POST {server}/schedule (сервер шлёт push в срок);
 *     - при срабатывании напоминания ВНУТРИ приложения сообщаем серверу
 *       POST {server}/suppress, чтобы не приходил дубль push.
 *  4. Баннер «Включить напоминания» — включение в один тап (iOS требует
 *     запрос разрешения из жеста пользователя).
 *  5. Экспортирует window.fletPush для push-setup.html:
 *     fletPush.subscribe() / unsubscribe() / status() / getUid() / config.
 *
 * ФИКС ЗВУКА (iOS): AudioContext создаётся заранее и разблокируется на
 * первом касании экрана.
 *
 * Все пути ОТНОСИТЕЛЬНЫЕ — работает из корня домена и из подпапки
 * (GitHub Pages: /ezhednevnik-offline/).
 */
(async function () {
  'use strict';

  if (typeof window === 'undefined') return;

  /* ================== НАСТРОЙКИ PUSH-СЕРВЕРА ==================
   * 1. PUSH_SERVER — адрес сервиса на Render, например
   *    https://ezhednevnik-push.onrender.com  (без / на конце).
   * 2. VAPID_PUBLIC_KEY — ПУБЛИЧНЫЙ VAPID-ключ (tools/generate_vapid_keys.py).
   *    Он же задан на сервере (из того же приватного ключа).
   * ============================================================ */
  const PUSH_SERVER = 'https://ezhednevnik-push.onrender.com';
  const VAPID_PUBLIC_KEY = 'BH5n1Po_d5bwGcex0i4qohzubGwT22LuPI9Km9u8PiSFXOZaBHCYia_NYKglKXJXtBA2E0Eun0sO46kRLjsCJZw';

  const NOTIFY_CHANNEL = 'ezh-notify';
  const APP_NAME = 'Ежедневник';
  const SCHEDULE_UPLOAD_INTERVAL_MS = 5 * 60 * 1000; // 5 минут, пока PWA открыта
  const SNAPSHOT_PREFIX = 'db_snapshot_';
  const DISMISS_KEY = 'ezh_push_banner_dismissed';

  const serverConfigured = /^https?:\/\//.test(PUSH_SERVER) && PUSH_SERVER.indexOf('ВАШ') === -1;

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

  /* uid берём из ключа снапшота localStorage (db_snapshot_<uid>) —
   * он появляется после входа в аккаунт и офлайн-сохранения данных. */
  const getUid = () => {
    const fromUrl = getUidFromUrl();
    if (fromUrl) return fromUrl;
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k && k.indexOf(SNAPSHOT_PREFIX) === 0) {
          const uid = k.slice(SNAPSHOT_PREFIX.length);
          if (uid && uid !== 'anon') return uid;
        }
      }
    } catch (e) { /* приватный режим и т.п. */ }
    return '';
  };

  const tzName = () => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
    catch (e) { return ''; }
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
      // на корне страницы. Push-события приходят в SW без контроля страницы.
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

  /* ============ PUSH-СЕРВЕР: расписание и подписка ============ */

  let lastScheduleBody = '';
  let scheduleUploading = false;

  const collectSchedule = () => {
    const uid = getUid();
    if (!uid) return null;
    let snap;
    try {
      const raw = localStorage.getItem(SNAPSHOT_PREFIX + uid);
      if (!raw) return null;
      snap = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    const tables = (snap && snap.tables) || {};
    const nowMs = Date.now();
    const HORIZON = 8 * 24 * 3600 * 1000; // 8 дней вперёд
    const reminders = [];
    (Array.isArray(tables.reminders) ? tables.reminders : []).forEach((r) => {
      if (!r || r.fired) return;
      const t = Date.parse(r.fire_at || '');
      if (!isFinite(t)) return;
      if (t < nowMs - 3600 * 1000 || t > nowMs + HORIZON) return;
      reminders.push({
        task_id: r.task_id | 0,
        task_text: String(r.task_text || ''),
        fire_at: r.fire_at,
        minutes_before: r.minutes_before | 0,
        kind: r.kind || 'before',
        repeat_interval_min: r.repeat_interval_min | 0,
        repeat_max: r.repeat_max | 0,
        repeat_count: r.repeat_count | 0,
      });
    });
    const tasks = {};
    (Array.isArray(tables.tasks) ? tables.tasks : []).forEach((t) => {
      if (!t || t.is_deleted) return;
      tasks[t.id] = [String(t.task || ''), String(t.datetime || ''), t.status | 0];
    });
    return { uid, timezone: tzName(), reminders, tasks };
  };

  /* Загружает расписание на сервер. Возвращает true при успехе. */
  const uploadSchedule = async (force) => {
    if (!serverConfigured || scheduleUploading || !navigator.onLine) return false;
    const payload = collectSchedule();
    if (!payload) return false;
    const body = JSON.stringify(payload);
    if (!force && body === lastScheduleBody) return true; // без изменений — не спамим
    scheduleUploading = true;
    try {
      await sendToServer(PUSH_SERVER + '/schedule', payload);
      lastScheduleBody = body;
      return true;
    } finally {
      scheduleUploading = false;
    }
  };

  /* Сообщает серверу «это напоминание уже показано внутри приложения» —
   * чтобы push не пришёл дублем, пока PWA открыта. */
  const suppressOnServer = async (data) => {
    if (!serverConfigured) return;
    const uid = getUid();
    if (!uid) return;
    try {
      await sendToServer(PUSH_SERVER + '/suppress', {
        uid: uid,
        task_id: data.task_id || 0,
      });
    } catch (e) { /* не критично */ }
  };

  /* ================= Баннер «Включить напоминания» ================= */

  let bannerEl = null;

  const setBannerText = (text) => {
    if (bannerEl) {
      const t = bannerEl.querySelector('.ezh-text');
      if (t) t.textContent = text;
    }
  };

  const hideBanner = () => {
    if (bannerEl) {
      bannerEl.remove();
      bannerEl = null;
    }
  };

  const showBanner = (text) => {
    if (bannerEl || !('Notification' in window)) return;
    const el = document.createElement('div');
    el.id = 'ezh-push-banner';
    el.style.cssText = [
      'position:fixed',
      'top:calc(env(safe-area-inset-top, 0px) + 8px)',
      'left:12px', 'right:12px',
      'z-index:2147483000',
      'display:flex', 'align-items:center', 'gap:10px',
      'background:#171A21', 'color:#E8EAED',
      'border:1px solid #2A3040', 'border-radius:14px',
      'padding:12px 14px',
      'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif',
      'font-size:15px', 'font-weight:600',
      'box-shadow:0 8px 30px rgba(0,0,0,.45)',
      'cursor:pointer',
      '-webkit-tap-highlight-color:transparent',
    ].join(';');

    const bell = document.createElement('span');
    bell.textContent = '🔔';
    bell.style.cssText = 'font-size:18px;flex:none';

    const txt = document.createElement('span');
    txt.className = 'ezh-text';
    txt.textContent = text || 'Включить напоминания';
    txt.style.cssText = 'flex:1;line-height:1.3';

    const close = document.createElement('span');
    close.textContent = '✕';
    close.style.cssText = 'flex:none;color:#9AA0A6;font-size:14px;padding:4px 2px';

    el.appendChild(bell);
    el.appendChild(txt);
    el.appendChild(close);

    const enableFlow = async () => {
      try {
        setBannerText('Запрашиваем разрешение…');
        await window.fletPush.subscribe();
        setBannerText('Уведомления включены ✓');
        try { localStorage.removeItem(DISMISS_KEY); } catch (e) {}
        setTimeout(hideBanner, 1600);
      } catch (e) {
        setBannerText('Не получилось: ' + (e && e.message ? e.message : 'ошибка'));
      }
    };

    el.addEventListener('click', (ev) => {
      if (ev.target === close) {
        hideBanner();
        try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) {}
        return;
      }
      enableFlow();
    });

    document.body.appendChild(el);
    bannerEl = el;
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
        // напоминание показано в приложении — серверу push на эту же минуту не нужен
        suppressOnServer(data);
        // расписание изменилось (напоминание сработало, могли создаться повторы)
        setTimeout(() => { uploadSchedule(true).catch(() => {}); }, 3500);
      };
    }
  } catch (e) { /* BroadcastChannel недоступен — не критично */ }

  /* ================= Web Push API ================= */

  window.fletPush = {
    supported: !!(swReg && 'PushManager' in window && 'Notification' in window),

    config: {
      server: PUSH_SERVER,
      vapidPublicKey: VAPID_PUBLIC_KEY,
      serverConfigured: serverConfigured,
    },

    getUid: getUid,

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
      if (!serverConfigured) throw new Error('Не задан адрес push-сервера (push-bridge.js, PUSH_SERVER)');

      const key = vapidKey || VAPID_PUBLIC_KEY;
      if (!key) throw new Error('VAPID-ключ не задан');

      const permission = await this.requestPermission();
      if (permission !== 'granted') throw new Error('Разрешение не выдано');

      let sub = await swReg.pushManager.getSubscription();
      if (!sub) {
        sub = await swReg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key),
        });
      }

      const uid = getUid();
      try {
        await sendToServer(PUSH_SERVER + '/subscribe', {
          uid: uid,
          timezone: tzName(),
          subscription: sub.toJSON(),
        });
      } catch (e) {
        if (!uid) throw new Error('Сервер недоступен или вход не выполнен (нет uid)');
        throw new Error('Не удалось передать подписку серверу: ' + (e && e.message));
      }

      // подписка готова — сразу отправляем расписание
      uploadSchedule(true).catch(() => {});
      return sub;
    },

    async unsubscribe() {
      if (!swReg) return false;
      const sub = await swReg.pushManager.getSubscription();
      if (!sub) return false;
      try {
        await sendToServer(PUSH_SERVER + '/unsubscribe', { endpoint: sub.endpoint });
      } catch (e) { /* локальная отписка важнее */ }
      return sub.unsubscribe();
    },
  };

  /* ================= Автозапуск ================= */

  try {
    if (window.fletPush.supported) {
      // Стартовая задержка: даём приложению восстановить сессию и снапшот.
      setTimeout(async () => {
        try {
          const st = await window.fletPush.status();
          let dismissed = false;
          try { dismissed = localStorage.getItem(DISMISS_KEY) === '1'; } catch (e) {}

          if (st.permission === 'granted') {
            if (!st.subscribed) {
              // разрешение есть, подписки нет (обновление браузера/SW) — молча восстановим
              await window.fletPush.subscribe().catch(() => {});
            } else {
              await uploadSchedule().catch(() => {});
            }
            hideBanner();
          } else if (st.permission === 'default') {
            if (!dismissed) showBanner();
          } else if (st.permission === 'denied') {
            console.info('[push-bridge] уведомления запрещены в настройках Safari');
          }

          // Периодическая загрузка расписания, пока приложение открыто
          setInterval(() => {
            if (document.visibilityState === 'visible') {
              uploadSchedule().catch(() => {});
            }
          }, SCHEDULE_UPLOAD_INTERVAL_MS);

          // Уход в фон — последний шанс синхронизировать расписание
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
              uploadSchedule().catch(() => {});
            }
          });
        } catch (e) {
          console.debug('[push-bridge] init skipped:', e && e.message);
        }
      }, 5000);
    }
  } catch (e) {
    console.debug('[push-bridge] autosubscribe skipped:', e && e.message);
  }
})();
