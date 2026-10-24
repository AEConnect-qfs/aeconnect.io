const fs = require('node:fs');
const path = require('node:path');
const { findKey, sitemapUrls, ping } = require('./ping');

/**
 * Netlify runs onSuccess after the deploy is live.
 * Production only: preview deploys must not submit aeconnect.io URLs
 * before this key file is on the production host.
 * A failed ping is logged and does not fail the deploy. A missing key file does.
 */
module.exports = {
  async onSuccess({ constants, utils }) {
    if (process.env.CONTEXT !== 'production') {
      console.log(`IndexNow skipped (CONTEXT=${process.env.CONTEXT || 'unset'})`);
      return;
    }
    const root = constants.PUBLISH_DIR;
    let key;
    try {
      key = findKey(root);
    } catch (error) {
      utils.build.failPlugin(error.message);
      return;
    }
    const urls = sitemapUrls(fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8'));
    try {
      const result = await ping({ key, urls });
      const ok = result.status === 200 || result.status === 202;
      console.log(`IndexNow ${result.status} for ${urls.length} URLs (key file /${key}.txt)`);
      if (!ok) console.warn(`IndexNow response: ${result.body.slice(0, 400)}`);
    } catch (error) {
      console.warn(`IndexNow ping failed: ${error.message}`);
    }
  },
};
