module.exports = {
  apps: [{
    name: 'games-portal-admin',
    cwd: '/home/ubuntu/games-portal/server',
    script: 'index.cjs',
    env: { NODE_ENV:'production', HOST:'127.0.0.1', PORT:'3010', GAMES_PORTAL_ROOT:'/home/ubuntu/games-portal' },
    autorestart: true,
    max_memory_restart: '120M'
  }]
};
