/* sw.js — service worker «Ежедневника» (Web Push для iPhone-PWA и браузеров).
 *
 * Обязанности:
 *  - получить push (сервер, notifications/web_push.py) и показать системное
 *    уведомление, даже если PWA закрыта (iOS 16.4+, Android, десктоп Chrome);
 *  - обработать тап по уведомлению: сфокусировать открытое окно или открыть app.
 *
 * РЕГИСТРАЦИЯ: push-bridge.js регистрирует этот файл СО СКОУПОМ '/push/'.
 * Это принципиально:
 *  1) не замещаем родной service worker Flet (flutter_service_worker.js) —
 *     замена SW на живой странице ломает ws-хендшейк сессии (бесконечный
 *     "Working...");
 *  2) для Web Push SW не обязан контролировать страницу — подписка создаётся
 *     через pushManager.subscribe() любого зарегистрированного SW.
 *
 * Осознанно НЕ кэширует ресурсы приложения: кэширование ломает обновления
 * сервер-режима Flet (страница и ws должны приходить свежими).
 */
const APP_NAME = 'Ежедневник';
const DEFAULT_ICON = './icons/icon-192.png';

// Без skipWaiting/clients.claim: SW не должен перехватывать уже открытые
// страницы. Push-события приходят в SW независимо от контроля страниц.
self.addEventListener('install', () => {});

self.addEventListener('activate', () => {});

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: APP_NAME, body: event.data.text() };
    }
  }

  const title = data.title || APP_NAME;
  const options = {
    body: data.body || '',
    icon: data.icon || DEFAULT_ICON,
    badge: DEFAULT_ICON,
    tag: data.tag || ('reminder-' + Date.now()),
    renotify: true,           // повторное уведомление с тем же tag вибрирует снова
    requireInteraction: false,
    silent: false,
    data: {
      url: data.url || '/',
      task_id: data.task_id || 0,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // фокусируем уже открытое окно приложения (url '/')
      for (const client of windowClients) {
        if ('focus' in client) {
          client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      // иначе открываем новое
      return self.clients.openWindow(target);
    })
  );
});
