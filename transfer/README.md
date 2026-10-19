# Transfer hosting

The page is https://www.jordanettinger.com/transfer/. Cloudflare is selected by default. Admins may choose Homeserver when the Worker reports it ready. A transfer's provider cannot be changed after creation.

Homeserver origin: https://files.jordanettinger.com. Deployed storage root: /mnt/storage1/homeserver-transfers. The existing /mnt/storage1/documents/transfer directory must remain untouched. The browser uses HTTPS capabilities and opaque IDs, never filesystem paths or the server API secret.

Homeserver files use streaming PUT uploads regardless of size. Cloudflare files above 5,000,000,000 bytes retain the existing multipart path. Recipient responses omit hosting metadata; direct download hostnames are still visible in browser network tools.

The backend/Worker live API checks passed on 2026-10-19. Frontend publication and browser acceptance are pending in this record. Check both providers in a browser for single/folder uploads, add-files, incorrect-password rejection, download behavior and deletion before declaring completion.

See ../documents/homeserver-transfer-handoff.md and ../portfolio-worker/README.md.
