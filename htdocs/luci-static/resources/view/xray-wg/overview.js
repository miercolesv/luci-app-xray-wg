/* SPDX-License-Identifier: GPL-3.0-or-later */

'use strict';
'require view';
'require ui';
'require rpc';
'require poll';
'require dom';

var callStatus = rpc.declare({
	object: 'luci.xray-wg',
	method: 'status'
});

var callAction = rpc.declare({
	object: 'luci.xray-wg',
	method: 'action',
	params: [ 'name' ]
});

var callExitIP = rpc.declare({
	object: 'luci.xray-wg',
	method: 'exit_ip'
});

function dot(state) {
	/* green / amber / red, using LuCI's own indicator colours */
	var colour = { ok: '#4caf50', warn: '#ff9800', bad: '#f44336' }[state] || '#9e9e9e';
	return E('span', {
		'style': 'display:inline-block;width:.75em;height:.75em;border-radius:50%;' +
		         'margin-right:.5em;vertical-align:baseline;background:' + colour
	});
}

function row(label, state, text) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '33%' }, [ E('strong', {}, label) ]),
		E('td', { 'class': 'td left' }, [ dot(state), text ])
	]);
}

function describeHandshake(age) {
	if (age === null || age === undefined)
		return [ 'bad', _('interface is down') ];
	if (age < 0)
		return [ 'warn', _('no handshake yet') ];
	if (age < 180)
		return [ 'ok', _('%ds ago').format(age) ];
	return [ 'warn', _('%ds ago - stale').format(age) ];
}

return view.extend({
	handleAction: function(name, ev) {
		var btn = ev.currentTarget;
		btn.classList.add('spinning');
		btn.disabled = true;

		return callAction(name).then(L.bind(function(res) {
			if (res && res.success) {
				ui.addNotification(null,
					E('p', _('Service %s requested.').format(name)), 'info');
			}
			else {
				var body = [ E('p', _('Could not %s the service.').format(name)) ];
				if (res && res.problems && res.problems.length)
					body.push(E('ul', {}, res.problems.map(function(p) {
						return E('li', {}, p);
					})));
				else if (res && res.output)
					body.push(E('pre', {}, res.output));
				ui.addNotification(null, body, 'error');
			}
			return this.refresh();
		}, this)).finally(function() {
			btn.classList.remove('spinning');
			btn.disabled = false;
		});
	},

	handleExitIP: function(ev) {
		var btn = ev.currentTarget;
		var out = document.getElementById('xwg-exit-ip');
		btn.classList.add('spinning');
		btn.disabled = true;

		return callExitIP().then(function(res) {
			if (!out)
				return;
			if (!res || !res.ip) {
				dom.content(out, E('em', {}, (res && res.error) || _('lookup failed')));
				return;
			}
			dom.content(out, E('code', {}, res.ip));
		}).finally(function() {
			btn.classList.remove('spinning');
			btn.disabled = false;
		});
	},

	refresh: function() {
		return callStatus().then(function(st) {
			var tbl = document.getElementById('xwg-status-table');
			var warn = document.getElementById('xwg-problems');
			if (!tbl)
				return;

			var hs = describeHandshake(st.iface_up ? st.handshake_age : null);

			dom.content(tbl, [
				row(_('Service'),
					st.enabled ? 'ok' : 'warn',
					st.enabled ? _('enabled') : _('disabled in settings')),
				row(_('xray'),
					st.xray_listening ? 'ok' : 'bad',
					st.xray_listening
						? _('listening on 127.0.0.1:%s').format(st.local_port)
						: _('not listening on 127.0.0.1:%s').format(st.local_port)),
				row(_('Host route'),
					st.route_pinned ? 'ok' : 'bad',
					st.route_pinned
						? _('%s pinned via %s').format(st.frontend, st.upstream || _('uplink'))
						: _('not pinned - xray traffic would loop into the tunnel')),
				row(_('Tunnel'),
					st.iface_up ? 'ok' : 'bad',
					st.iface_up ? _('%s is up').format(st.iface)
					            : _('%s is down').format(st.iface)),
				row(_('Last handshake'), hs[0], hs[1]),
				row(_('Server'), st.server_host ? 'ok' : 'bad',
					st.server_name
						? '%s (%s)'.format(st.server_name, st.server_host)
						: _('none selected'))
			]);

			if (warn) {
				if (st.problems && st.problems.length)
					dom.content(warn, E('div', { 'class': 'alert-message warning' }, [
						E('p', {}, E('strong', {}, _('The service will not start until these are fixed:'))),
						E('ul', {}, st.problems.map(function(p) { return E('li', {}, p); })),
						E('p', {}, E('a', { 'href': L.url('admin/vpn/xray-wg/settings') },
							_('Go to Settings')))
					]));
				else
					dom.content(warn, []);
			}
		});
	},

	load: function() {
		return callStatus();
	},

	render: function() {
		var page = E([], [
			E('h2', {}, _('Xray WireGuard')),
			E('p', { 'class': 'cbi-section-descr' },
				_('WireGuard wrapped in a VMess/TCP transport, so the local network and the ISP see ordinary HTTP traffic.')),

			E('div', { 'id': 'xwg-problems' }),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Status')),
				E('table', { 'class': 'table', 'id': 'xwg-status-table' }, [
					E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td' }, E('em', {}, _('Collecting data...')))
					])
				])
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Exit address')),
				E('p', { 'class': 'cbi-section-descr' },
					_('Fetched through the tunnel on demand, not polled. It resolves a hostname inside the tunnel, so it reports a failure when no DNS server is set under Settings even though the tunnel itself is fine.')),
				E('p', {}, [
					E('button', {
						'class': 'cbi-button cbi-button-neutral',
						'click': ui.createHandlerFn(this, 'handleExitIP')
					}, _('Check exit address')),
					' ',
					E('span', { 'id': 'xwg-exit-ip' })
				])
			]),

			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', {
					'class': 'cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(this, 'handleAction', 'start')
				}, _('Connect')),
				' ',
				E('button', {
					'class': 'cbi-button cbi-button-negative',
					'click': ui.createHandlerFn(this, 'handleAction', 'stop')
				}, _('Disconnect')),
				' ',
				E('button', {
					'class': 'cbi-button cbi-button-neutral',
					'click': ui.createHandlerFn(this, 'handleAction', 'restart')
				}, _('Reconnect'))
			])
		]);

		poll.add(L.bind(this.refresh, this), 5);

		return page;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
