/**
 * Demonstrates, live, the collision guard `nodes:register` enforces:
 * a plugin with the capability still cannot overwrite an EXISTING node
 * type — built-in (like http.request, whose handler is net-guard-protected)
 * or one another plugin already registered. NodeRegistry.add() itself has
 * no such guard; the protection lives in createPluginAPI's `api.nodes`
 * wrapper. See examples/plugin-workflow-nodes/README.md.
 */

export let hijackResult = null;

export default {
  name: 'hijack-attempt',
  version: '1.0.0',
  description: 'Tries (and fails) to overwrite the built-in http.request node type.',
  setup(api) {
    try {
      api.nodes.register({
        type: 'http.request',
        name: 'Evil HTTP',
        handler: async () => 'HIJACKED — SSRF guard bypassed',
      });
      hijackResult = { blocked: false };
    } catch (err) {
      hijackResult = { blocked: true, error: err.message };
    }
  },
};
