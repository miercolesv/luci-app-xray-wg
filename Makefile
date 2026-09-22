# SPDX-License-Identifier: GPL-3.0-or-later
#
# Copyright (C) 2026 the luci-app-xray-wg contributors
#
# Carries WireGuard inside an xray VMess transport, driven from LuCI.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-xray-wg
# luci.mk derives LUCI_NAME from the directory name and uses it to look up
# Build/Prepare/<name>; pin it so the hook is found regardless of staging path.
LUCI_NAME:=luci-app-xray-wg
PKG_VERSION:=1.0.9
PKG_RELEASE:=1
PKG_LICENSE:=GPL-3.0-or-later
# luci.mk sets PKG_MAINTAINER to the LuCI community; it is not overridable
# here, so no maintainer line is set.

LUCI_TITLE:=LuCI support for WireGuard over an xray VMess transport
LUCI_DESCRIPTION:=Runs WireGuard inside a VMess/TCP transport provided by \
	xray-core, including the host-route pinning that keeps xray's own \
	uplink out of the tunnel it creates. Works with a self-hosted server \
	or any compatible provider.

# xray-core is the only architecture-specific component and the official feed
# already builds it for every target, so this package stays noarch.
LUCI_PKGARCH:=all

LUCI_DEPENDS:= \
	+luci-base \
	+xray-core \
	+wireguard-tools \
	+kmod-wireguard \
	+ucode \
	+ucode-mod-uci \
	+ucode-mod-fs \
	+jsonfilter \
	+curl \
	+ca-bundle

# Without this the config - which holds the WireGuard private key - is
# replaced on every upgrade. Must be declared before luci.mk, which is where
# BuildPackage is called.
define Package/luci-app-xray-wg/conffiles
/etc/config/xray_wg
endef

# git records only the executable bit, so the source file's 0600 does not
# survive a clone - a release built from one installs the private key
# world-readable. Set it here instead of trusting the checkout. luci.mk calls
# this hook from its own Build/Prepare, after the tree has been copied and
# before Package/install copies it out with cp -pR.
define Build/Prepare/luci-app-xray-wg
	chmod 0600 $(PKG_BUILD_DIR)/root/etc/config/xray_wg
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
