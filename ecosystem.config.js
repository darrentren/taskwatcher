module.exports = {
  apps: [{
    name: 'taskwatcher',
    script: 'server.js',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    env: {
      TW_HOST: '127.0.0.1',  // stays localhost; nginx handles public traffic
      TW_PORT: '3747'
    },
    env_production: {
      TW_HOST: '0.0.0.0',    // use only if NOT behind a reverse proxy
      TW_PORT: '3747'
    }
  }]
};
