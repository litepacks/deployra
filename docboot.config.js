/** @type {import('docboot').DocbootConfig} */
export default {
  title: 'Deployra',
  description: 'Lightweight, platform-independent VPS deployment orchestrator',
  docs: './docs',
  out: './dist-docs',
  base: process.env.DOCBOOT_BASE || '/gitship/',
  siteUrl: 'https://litepacks.github.io/gitship/',
  repo: 'https://github.com/litepacks/deployra',
  theme: {
    preset: 'ocean',
    defaultMode: 'system',
  },
  editLink: {
    pattern: 'https://github.com/litepacks/deployra/edit/main/docs/:path',
  },
  sourceLink: {
    pattern: 'https://github.com/litepacks/deployra/blob/main/docs/:path',
  },
  search: {
    fuzzy: 0.2,
    prefix: true,
    maxResults: 10,
  },
};
