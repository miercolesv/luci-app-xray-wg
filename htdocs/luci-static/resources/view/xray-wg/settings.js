/* SPDX-License-Identifier: GPL-3.0-or-later */

'use strict';
'require view';
'require form';
'require ui';
'require rpc';
'require uci';
'require dom';

var callServers = rpc.declare({
	object: 'luci.xray-wg',
	method: 'servers'
});

var callProfiles = rpc.declare({
	object: 'luci.xray-wg',
	method: 'profiles'
});

/* The URL is passed in rather than read from UCI by the backend: a refresh has
   to work on a URL that is still only in the form, because nothing can be
   picked yet and so there is nothing worth saving first. */
var callRefresh = rpc.declare({
	object: 'luci.xray-wg',
	method: 'refresh',
	params: [ 'url' ]
});

var WG_KEY_RE = /^[A-Za-z0-9+/]{42}[A-Za-z0-9+/=]{2}$/;
var UUID_RE = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

/* Accepts a wg-quick style config as produced by most providers and by
   wg-quick itself.
   Parsed in the browser and pushed straight into the visible fields, so the
   values travel through the form's normal save path - writing UCI from a
   helper option's write() would race the real fields' own write()/remove().  */
function parseWgConfig(text) {
	var out = {}, m;

	/* \r must be allowed in the trailing run: a config downloaded on Windows
	   is CRLF, and \S+ stops at the \r while [ \t]*$ cannot consume it. */
	if ((m = text.match(/^[ \t]*PrivateKey[ \t]*=[ \t]*(\S+)[ \t\r]*$/mi)) !== null)
		out.private_key = m[1];
	if ((m = text.match(/^[ \t]*Address[ \t]*=[ \t]*(.+?)[ \t\r]*$/mi)) !== null)
		out.address = m[1].split(',')[0].trim();
	if ((m = text.match(/^[ \t]*DNS[ \t]*=[ \t]*(.+?)[ \t\r]*$/mi)) !== null)
		out.dns = m[1].split(',')[0].trim();

	return out;
}

/* Pushes values into sibling widgets of the same section, so they travel
   through the form's own save path and stay visible and editable. */
function fillFields(section, section_id, values) {
	var filled = [];

	for (var key in values) {
		var el = section.getUIElement(section_id, key);
		if (el) {
			el.setValue(values[key]);
			filled.push(key);
		}
	}

	return filled;
}

function heading(s, name, text) {
	var o = s.option(form.DummyValue, name, ' ');
	o.rawhtml = true;
	o.cfgvalue = function() { return '<strong>%s</strong>'.format(text); };
	o.write = function() {};
	o.remove = function() {};
	return o;
}

function sourceLabel(source, count) {
	var note = {
		api: _('freshly fetched'),
		cache: _('from the last refresh'),
		bundled: _('offline placeholder'),
		none: _('not fetched yet')
	}[source] || source;

	return '%s &#8212; %d %s'.format(note, count, _('usable servers'));
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('xray_wg'),
			uci.load('network'),
			L.resolveDefault(callServers(), { servers: [], source: 'none' }),
			L.resolveDefault(callProfiles(), { profiles: [] })
		]);
	},

	/* Rebuilds the picker in place. A page reload here would silently discard
	   a WireGuard config the user had already pasted but not yet saved. */
	handleRefresh: function(ev) {
		var self = this;
		var btn = ev.currentTarget;

		/* Whatever is in the field right now, saved or not. */
		var el = this.settingsSection
			? this.settingsSection.getUIElement('settings', 'list_url') : null;
		var url = el ? (el.getValue() || '') : '';

		btn.classList.add('spinning');
		btn.disabled = true;

		return callRefresh(url).then(function(res) {
			if (!res || !res.servers || !res.servers.length) {
				ui.addNotification(null, E('p',
					(res && res.error) || _('Could not fetch the server list.')), 'error');
				return;
			}

			self.setServers(res.servers, res.source || 'api');

			var pick = self.pickOption
				? self.pickOption.section.getUIElement('server', '_pick') : null;

			if (pick) {
				var current = pick.getValue();
				var labels = {};
				self.servers.forEach(function(sv) { labels[sv.host] = sv.label; });

				pick.clearChoices();
				pick.addChoices(self.servers.map(function(sv) { return sv.host; }), labels);

				if (current && labels[current])
					pick.setValue(current);
			}

			var note = document.getElementById('xwg-server-source');
			if (note)
				note.innerHTML = sourceLabel(self.source, self.servers.length);

			ui.addNotification(null, E('p',
				_('Fetched %d servers. Pick one, then Save & Apply.')
					.format(self.servers.length)), 'info');
		}).catch(function(err) {
			ui.addNotification(null, E('p', _('Refresh failed: %s').format(err.message)), 'error');
		}).finally(function() {
			btn.classList.remove('spinning');
			btn.disabled = false;
		});
	},

	setServers: function(list, source) {
		this.servers = (list || []).slice().sort(function(a, b) {
			return a.label.localeCompare(b.label);
		});
		this.source = source;
		this.byHost = {};
		this.servers.forEach(function(sv) { this.byHost[sv.host] = sv; }, this);
	},

	render: function(data) {
		var self = this;
		var listing = data[2] || { servers: [], source: 'none' };
		var profiles = (data[3] && data[3].profiles) || [];

		this.setServers(listing.servers, listing.source);

		var m, s, o;
		/* The profile picker and the Refresh button live in the Server section
		   but read and write the Tunnel section's options, and getUIElement()
		   only looks inside its own section - so keep a reference to it.
		   Options themselves stay in the section that owns their UCI keys. */
		this.settingsSection = null;

		m = new form.Map('xray_wg', _('Xray WireGuard'),
			_('Carries WireGuard inside an xray VMess transport. The WireGuard interface, the firewall zone and the host route that keeps the tunnel from swallowing its own uplink are all applied for you.'));

		/* ======================= Server ======================= */

		s = m.section(form.NamedSection, 'server', 'server', _('Server'),
			_('Either pick a server from a published list, or type the four values in by hand for a server you run yourself.'));
		s.anonymous = true;
		s.addremove = false;

		var serverSection = s;

		if (profiles.length) {
			o = s.option(form.ListValue, '_profile', _('Profile'),
				_('Pre-fills the server-list endpoint and the Host header under "Tunnel". Everything else still comes from the list, or from what you type below.'));
			o.write = function() {};
			o.remove = function() {};
			o.cfgvalue = function() {
				var cur = uci.get('xray_wg', 'settings', 'list_url') || '';
				var hit = profiles.filter(function(p) { return (p.list_url || '') === cur; })[0];
				return hit ? hit.id : (profiles[0] && profiles[0].id);
			};
			profiles.forEach(function(p) { o.value(p.id, p.name); });
			o.onchange = function(ev, section_id, value) {
				var p = profiles.filter(function(x) { return x.id === value; })[0];
				if (!p || !self.settingsSection)
					return;

				var vals = { list_url: p.list_url || '' };
				if (p.http_host)
					vals.http_host = p.http_host;

				fillFields(self.settingsSection, 'settings', vals);

				if (p.note)
					ui.addNotification(null, E('p', p.note), 'info');
			};
		}

		o = s.option(form.DummyValue, '_source', _('Server list'));
		o.rawhtml = true;
		o.cfgvalue = function() {
			return '<span id="xwg-server-source">%s</span>'
				.format(sourceLabel(self.source, self.servers.length));
		};
		o.write = function() {};
		o.remove = function() {};

		o = s.option(form.Button, '_refresh', ' ',
			_('Fetches the list from "Server list URL" under "Tunnel". The field does not have to be saved first.'));
		o.inputtitle = _('Refresh server list');
		o.inputstyle = 'apply';
		o.write = function() {};
		o.remove = function() {};
		o.onclick = function(ev) {
			return self.handleRefresh(ev);
		};

		/* A convenience, never a requirement: it must be possible to save a
		   config that was typed in by hand, and to save a server-list URL
		   before any list has been fetched. */
		o = s.option(form.ListValue, '_pick', _('Pick from the list'),
			_('Fills in the address, the frontend and the peer key together, so the three can never disagree. Leave it alone to keep what is set below.'));
		o.optional = true;
		o.write = function() {};
		o.remove = function() {};
		o.cfgvalue = function() {
			return uci.get('xray_wg', 'server', 'host') || '';
		};
		o.onchange = function(ev, section_id, value) {
			var sv = self.byHost[value];
			if (!sv)
				return;

			fillFields(serverSection, section_id || 'server', {
				name: sv.label,
				host: sv.host,
				/* The published list calls this field 'v2ray'; the config
				   calls it what it is. */
				frontend: sv.v2ray,
				public_key: sv.public_key,
				dns_name: sv.dns_name || '',
				/* Cleared on purpose: for a listed server both come from the
				   fetched list, and a value left over from a hand-typed server
				   would silently take precedence over it. */
				uuid: '',
				wg_port: ''
			});

			ui.addNotification(null, E('p',
				_('Filled in from %s. Review, then Save & Apply.').format(sv.label)), 'info');
		};

		var current = uci.get('xray_wg', 'server', 'host') || '';

		if (!this.servers.length)
			o.value('', _('-- no list fetched --'));

		/* Keep whatever is configured selectable even if it is absent from the
		   list we just fetched, so a Save cannot silently move the user off it. */
		if (current && !this.byHost[current])
			o.value(current, '%s (%s)'.format(
				uci.get('xray_wg', 'server', 'name') || _('configured'), current));

		this.servers.forEach(function(sv) { o.value(sv.host, sv.label); });

		this.pickOption = o;

		o = s.option(form.Value, 'name', _('Label'),
			_('Shown on the Status page. Cosmetic.'));
		o.placeholder = _('my server');

		o = s.option(form.Value, 'host', _('Server address'),
			_('Where WireGuard is listening. xray dials it through the transport, so WireGuard itself never learns it.'));
		o.datatype = 'host';
		o.placeholder = 'vpn.example.org';

		o = s.option(form.Value, 'wg_port', _('WireGuard port'),
			_('The port WireGuard listens on at that address. Leave empty only if a fetched server list publishes it.'));
		o.datatype = 'port';
		o.placeholder = '51820';

		o = s.option(form.Value, 'frontend', _('VMess frontend address'),
			_('Where the xray frontend is listening. Often the same address as above.'));
		o.datatype = 'host';
		o.placeholder = 'vpn.example.org';

		o = s.option(form.Value, 'frontend_port', _('Frontend port'),
			_('Port the VMess frontend listens on. 80 and 443 attract the least attention; any port works.'));
		o.datatype = 'port';
		o.value('80');
		o.value('443');

		o = s.option(form.Value, 'uuid', _('VMess id'),
			_('The user id the frontend expects. Leave empty only if a fetched server list publishes it.'));
		o.placeholder = '00000000-0000-0000-0000-000000000000';
		o.validate = function(section_id, value) {
			if (!value)
				return true;
			return UUID_RE.test(value) ? true : _('Not a UUID.');
		};

		o = s.option(form.Value, 'public_key', _('Peer public key'),
			_('The server\'s WireGuard public key - not yours.'));
		o.validate = function(section_id, value) {
			if (!value)
				return true;
			return WG_KEY_RE.test(value) ? true
				: _('Does not look like a WireGuard key (44 base64 characters).');
		};

		/* Carried so a picked server keeps the label the list gave it. Hidden
		   rather than dropped: nothing reads it, but a real widget keeps the
		   single save path that the picker relies on. */
		s.option(form.HiddenValue, 'dns_name');

		/* =================== Your credentials =================== */
		/* One NamedSection per UCI section: two over the same section would
		   render duplicate containers and parse the section twice. */

		s = m.section(form.NamedSection, 'wg', 'wireguard', _('Your WireGuard credentials'),
			_('Your own keys, not the server\'s.'));
		s.anonymous = true;
		s.addremove = false;

		var wgSection = s;

		o = s.option(form.TextValue, '_import', _('Paste WireGuard config'),
			_('Optional shortcut. Paste a wg-quick config and press "Fill in fields below". Nothing is stored until you Save.'));
		o.rows = 6;
		o.placeholder = '[Interface]\nPrivateKey = ...\nAddress = 172.16.0.2/32\nDNS = 172.16.0.1';
		o.cfgvalue = function() { return ''; };
		o.write = function() {};
		o.remove = function() {};

		o = s.option(form.Button, '_import_apply', ' ');
		o.inputtitle = _('Fill in fields below');
		o.inputstyle = 'apply';
		o.write = function() {};
		o.remove = function() {};
		o.onclick = function(ev, section_id) {
			var sid = section_id || 'wg';
			var src = wgSection.getUIElement(sid, '_import');
			var text = src ? (src.getValue() || '') : '';

			if (!text.trim()) {
				ui.addNotification(null, E('p', _('Nothing pasted.')), 'warning');
				return;
			}

			var filled = fillFields(wgSection, sid, parseWgConfig(text));

			if (!filled.length) {
				ui.addNotification(null, E('p',
					_('Could not find PrivateKey, Address or DNS in that text.')), 'warning');
				return;
			}

			/* Clear the paste box: it is a shortcut, not somewhere to leave a key. */
			if (src)
				src.setValue('');

			ui.addNotification(null, E('p',
				_('Filled in: %s. Review, then Save & Apply.').format(filled.join(', '))), 'info');
		};

		/* Everything that ships empty is optional here. The service refuses to
		   start on an incomplete config and says exactly what is missing, so
		   starting is the gate - saving is not, or a half-filled form could
		   never be put down and picked up again. */

		o = s.option(form.Value, 'private_key', _('Private key'));
		o.password = true;
		o.validate = function(section_id, value) {
			if (!value)
				return true;
			return WG_KEY_RE.test(value) ? true
				: _('Does not look like a WireGuard key (44 base64 characters).');
		};

		o = s.option(form.Value, 'address', _('Assigned address'),
			_('The address assigned to you, including the prefix length.'));
		o.datatype = 'cidr';
		o.placeholder = '172.16.0.2/32';

		o = s.option(form.Value, 'dns', _('DNS server inside the tunnel'),
			_('Leave empty only if you accept DNS going to the upstream network\'s resolver.'));
		o.datatype = 'ipaddr';

		heading(s, '_wg_adv', _('Advanced'));

		o = s.option(form.Value, 'iface', _('Interface name'),
			_('The network interface this package creates and manages.'));
		o.datatype = 'uciname';
		o.rmempty = false;

		o = s.option(form.Value, 'mtu', _('MTU'),
			_('VMess framing inflates packets; the usual 1420 fragments. 1280 is the safe default.'));
		o.datatype = 'range(576,1500)';
		o.rmempty = false;

		o = s.option(form.Value, 'persistent_keepalive', _('Persistent keepalive'));
		o.datatype = 'range(0,65535)';

		/* ======================= Tunnel ======================= */

		s = m.section(form.NamedSection, 'settings', 'settings', _('Tunnel'));
		s.anonymous = true;
		s.addremove = false;
		this.settingsSection = s;

		o = s.option(form.Flag, 'enabled', _('Enable'),
			_('Start the tunnel now and on every boot.'));
		o.rmempty = false;

		o = s.option(form.ListValue, 'mode', _('Obfuscation mode'),
			_('Only VMess over TCP is implemented and tested.'));
		o.value('tcp', _('VMess / TCP (HTTP-disguised)'));

		o = s.option(form.Value, 'list_url', _('Server list URL'),
			_('Optional. An endpoint publishing servers to choose from, used by "Refresh server list" above. Leave empty for a server you run yourself and fill the fields in by hand.'));
		o.placeholder = 'https://example.org/servers.json';
		o.validate = function(section_id, value) {
			if (!value)
				return true;
			return /^https?:\/\/[^\s]+$/.test(value) ? true
				: _('Must be an http:// or https:// URL.');
		};

		o = s.option(form.Value, 'http_host', _('HTTP Host header'),
			_('Sent by the disguised TCP transport. Must match what the server expects.'));
		o.datatype = 'hostname';
		o.placeholder = 'www.example.com';

		o = s.option(form.Value, 'upstream_iface', _('Uplink interface'),
			_('The interface carrying the real internet connection. Detected at install time; change it only if detection got it wrong.'));
		uci.sections('network', 'interface', function(sec) {
			if (sec['.name'] != 'loopback' &&
			    sec['.name'] != uci.get('xray_wg', 'wg', 'iface'))
				o.value(sec['.name']);
		});

		heading(s, '_set_adv', _('Advanced'));

		o = s.option(form.Value, 'local_port', _('Local xray port'),
			_('UDP port on loopback where WireGuard hands packets to xray. Pinned rather than random, so the WireGuard peer stays stable across restarts. If it is already taken the service will say so when you press Connect.'));
		o.datatype = 'port';
		o.rmempty = false;

		o = s.option(form.ListValue, 'loglevel', _('xray log level'));
		[ 'none', 'error', 'warning', 'info', 'debug' ].forEach(function(l) {
			o.value(l);
		});

		/* ====================== Firewall ====================== */

		s = m.section(form.NamedSection, 'firewall', 'firewall', _('Firewall'));
		s.anonymous = true;
		s.addremove = false;

		o = s.option(form.Flag, 'manage', _('Manage the firewall automatically'),
			_('Creates a masquerading zone for the tunnel and mirrors the forwardings that currently target your uplink zone. Turn this off only if you maintain the rules yourself.'));
		o.rmempty = false;

		o = s.option(form.Value, 'zone_name', _('Firewall zone name'));
		o.datatype = 'uciname';
		o.depends('manage', '1');

		return m.render();
	}
});
