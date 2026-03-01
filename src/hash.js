'use strict';

const crypto = require('crypto');

function sha256(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex');
}

module.exports = { sha256 };
