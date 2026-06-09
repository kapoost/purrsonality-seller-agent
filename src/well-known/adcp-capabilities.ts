// Public AdCP capabilities manifest served at /.well-known/adcp-capabilities.json.
//
// Defense-in-depth discovery: AdCP-aware clients (AAO comply suite, buyer
// agents) can identify role + specialisms + supported skills without auth,
// even when the MCP endpoint is bearer-walled and `tools/list` returns 401.
// Mirrors the data the SDK returns from the `get_adcp_capabilities` tool —
// kept in sync via platform.capabilities + SKILL_IDS, not hand-rolled.

import { platform } from '../platform.ts';
import { SKILL_IDS } from './agent-card.ts';

interface AdcpCapabilitiesOptions {
  agentUrl: string;
  agentName: string;
}

export function buildAdcpCapabilities(
  opts: AdcpCapabilitiesOptions,
): Record<string, unknown> {
  return {
    adcp_version: '3.0',
    agent: {
      name: opts.agentName,
      url: opts.agentUrl,
      role: 'seller',
    },
    specialisms: [...platform.capabilities.specialisms],
    channels: [...(platform.capabilities.channels ?? [])],
    pricing_models: [...(platform.capabilities.pricingModels ?? [])],
    supported_protocols: ['media_buy', 'creative', 'accounts'],
    capabilities: [...SKILL_IDS],
    account_resolution: 'implicit',
    compliance_testing: {
      scenarios: [...(platform.capabilities.compliance_testing?.scenarios ?? [])],
    },
    transports: [
      {
        type: 'https',
        endpoint: opts.agentUrl,
        auth: { type: 'bearer' },
      },
    ],
  };
}

interface OAuthResourceOptions {
  resource: string;
}

// RFC 9728 OAuth Protected Resource Metadata for /mcp. Empty
// authorization_servers signals "bearer-only, pre-shared token" — clients
// that need an authorization server URL will fail gracefully here instead
// of looping on a 404. resource_documentation points at the repo for
// humans who need to negotiate a token.
export function buildOAuthProtectedResource(
  opts: OAuthResourceOptions,
): Record<string, unknown> {
  return {
    resource: opts.resource,
    authorization_servers: [],
    bearer_methods_supported: ['header'],
    resource_documentation:
      'https://github.com/kapoost/purrsonality-seller-agent#authentication',
  };
}
