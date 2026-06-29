#!/bin/bash
# Custom RPM %postun (after-remove) scriptlet.
#
# electron-builder's default generates:
#     update-alternatives --remove 'squadron' '/usr/bin/squadron'
# which is wrong on two counts:
#   1. --remove expects the real target path, not the symlink, so it passes
#      /usr/bin/squadron instead of /opt/Squadron/squadron. update-alternatives
#      rejects it (exit 2), and because RPM runs the OLD version's %postun during
#      an upgrade, dnf reports "Transaction failed" on every upgrade.
#   2. It runs on upgrades too ($1 >= 1), where it would remove the alternative
#      the newly-installed version just registered.
#
# This version only cleans up on a real uninstall ($1 == 0), uses the correct
# target path, and never fails the transaction.
if [ "$1" = "0" ]; then
    if type update-alternatives >/dev/null 2>&1; then
        update-alternatives --remove 'squadron' '/opt/Squadron/squadron' || true
    else
        rm -f '/usr/bin/squadron' || true
    fi
fi
exit 0
