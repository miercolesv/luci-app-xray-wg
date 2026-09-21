# Signing keys

`xray-wg-repo.pub.pem` is the **public** key for the apk repository
published by this project. Install it on the router so `apk` will trust the
repository index and the packages in it:

    /etc/apk/keys/xray-wg-repo.pub.pem

Its SHA-256 fingerprint (DER form) is printed by the release workflow so you
can compare what you downloaded against what CI published:

    openssl rsa -pubin -in xray-wg-repo.pub.pem -outform DER | sha256sum

The matching **private** key is not in this repository and never will be. It
exists only as the `APK_SIGN_KEY` repository secret, which the build workflow
writes to a temporary file, uses, and discards with the runner.

Nothing here protects you from the maintainer: a signature proves a package
came from whoever holds that key, not that the package is safe. Read
`../README.md` for what this software actually does.

Fingerprint of the key in this repo:

    9397cefe1dac04fedac272673b79818b064b51aa169251e88f3b5eceb2d299fd
