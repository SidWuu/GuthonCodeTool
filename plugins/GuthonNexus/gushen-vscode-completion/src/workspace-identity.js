const metadata = require('../data/tool-command-metadata.json');
const pattern = new RegExp(`^(?:products|projects)\\.${metadata.configIdPattern}$`);
function isWorkspaceKey(value) { return typeof value === 'string' && pattern.test(value); }
module.exports = {isWorkspaceKey};
