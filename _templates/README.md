# Proposal templates

Files under `_templates` are retained as working source but are excluded from the GitHub Pages site build.

Cloudflare Pages publishes `.pages-dist`, prepared by the project's configured build command from the public site folders only (`about`, `assets`, `contact`, `portfolio`, `projects`, `reel`, `review`, `transfer`, plus `index.html` and `CNAME`). Templates, backend code, and local working files are excluded. Cloudflare Pages does not use Workers' `.assetsignore` file. Add any new public top-level folder to that build command before publishing it through Cloudflare.

To create a new proposal, copy `ubc-proposal` to a public folder with the desired URL slug, then update the proposal content and social-image URLs before publishing.
