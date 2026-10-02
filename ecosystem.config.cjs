/*
 * Конфигурация PM2.
 *
 * Ключевое здесь — `max_restarts` и `min_uptime` вместе. Ошибка в
 * `config/sources.yml` или `.env` не исправляется повторным запуском: бот падает
 * на первой же строке, pm2 его поднимает, тот снова падает. Без этих полей цикл
 * писал бы в лог одну и ту же ошибку сотни раз, пока не кончится место на диске.
 *
 * `min_uptime: 60000` означает «упал меньше чем через минуту после старта»,
 * `max_restarts: 5` — «пять таких подряд, и всё». Дальше pm2 останавливает
 * процесс и ждёт человека: править нужно причину, а не количество попыток.
 *
 * Запуск:  pm2 start ecosystem.config.cjs
 * Статус:  pm2 status
 * Логи:    pm2 logs vk-feed-bot
 */

module.exports = {
  apps: [
    {
      name: 'vk-feed-bot',
      script: 'dist/index.js',
      exec_mode: 'fork',
      instances: 1,

      autorestart: true,
      max_restarts: 5,
      min_uptime: 60_000,

      /*
       * Пауза между рестартами растёт: 5с, 10с, 15с… до минуты. Даёт время
       * прочитать ошибку в логе вместо того, чтобы её проскроллить.
       */
      restart_delay: 5_000,
      exp_backoff_restart_delay: true,

      /*
       * SIGINT — это Ctrl+C и pm2 reload. При остановке бот успевает доработать
       * текущий пост и закрыть базу; SIGKILL через 10с на случай, если завис.
       */
      kill_timeout: 10_000,

      max_memory_restart: '400M',
      time: true,
      merge_logs: true
    }
  ]
};