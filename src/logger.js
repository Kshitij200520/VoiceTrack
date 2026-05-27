/**
 * LOGGER — Winston-based structured logging
 */

const winston = require('winston');
const fs = require('fs-extra');

fs.ensureDirSync('./logs');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...rest }) => {
          const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
          return `${timestamp} [${level}] ${message}${extra}`;
        })
      ),
    }),
    new winston.transports.File({ filename: './logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: './logs/combined.log' }),
  ],
});

module.exports = logger;
