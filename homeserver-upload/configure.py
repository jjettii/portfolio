#!/usr/bin/env python3
"""Owner-run, interactive first-time configuration for the upload service."""
import getpass
import os
import secrets


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run with sudo python3 configure.py on the homeserver.')
    target = '/etc/portfolio-uploads.env'
    if os.path.exists(target):
        raise SystemExit('Secrets file already exists; preserved without changes.')
    password = getpass.getpass('Upload admin password (12+ characters; spaces allowed): ')
    if len(password) < 12 or not password.isprintable() or not password.strip():
        raise SystemExit('Use at least 12 printable characters. Spaces are allowed.')
    if password != getpass.getpass('Repeat upload admin password: '):
        raise SystemExit('Passwords did not match; no configuration was written.')
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as config:
        quoted_password = password.replace('\\', '\\\\').replace('"', '\\"')
        config.write('UPLOAD_ADMIN_SECRET="' + quoted_password + '"\n')
        config.write('UPLOAD_SIGNING_KEY=' + secrets.token_urlsafe(48) + '\n')
        config.write('UPLOAD_ROOT=/mnt/storage1/homeserver-uploads/data\n')
        config.write('UPLOAD_SITE_ORIGIN=https://www.jordanettinger.com\n')
        config.write('UPLOAD_QUOTA_BYTES=536870912000\n')
        config.flush()
        os.fsync(config.fileno())
    print('Created private configuration with a 500 GiB quota. No credentials were printed.')


if __name__ == '__main__':
    main()
