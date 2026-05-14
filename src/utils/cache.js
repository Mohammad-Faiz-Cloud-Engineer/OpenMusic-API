const NodeCache = require('node-cache');

const searchCache = new NodeCache({ stdTTL: 300 });
const streamCache = new NodeCache({ stdTTL: 1800 });
const metadataCache = new NodeCache({ stdTTL: 600 });

module.exports = { searchCache, streamCache, metadataCache };
