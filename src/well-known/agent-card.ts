// A2A Agent Card — minimal discovery surface served at /.well-known/agent.json
// on the agent's public domain (Google A2A protocol, github.com/google/A2A).
//
// AdCP currently bundles agent metadata in adagents.json (publisher-side) and
// the MCP capabilities response. This card is the A2A-compatible mirror so
// buyer agents using A2A-first discovery libraries can find us without
// negotiating MCP first.
//
// Skills examples are intentionally verbose for now (A2A is a learning surface
// while spec stabilises). Strip them once buyer-side tooling reliably resolves
// skills via MCP introspection instead of duplicating natural-language hints.

interface AgentCardOptions {
  agentUrl: string;
  version: string;
}

export function buildAgentCard(opts: AgentCardOptions): Record<string, unknown> {
  return {
    name: 'Purrsonality Seller',
    description:
      'Single-slot non-guaranteed display seller for purrsonality.rocketscience.pl (cat-personality quiz result page). ' +
      'AdCP 3.0 protocol via MCP transport. Reference implementation: ' +
      'https://github.com/kapoost/purrsonality-seller-agent',
    url: opts.agentUrl,
    version: opts.version,
    provider: {
      organization: 'kapoost',
      url: 'https://github.com/kapoost',
    },
    documentationUrl: 'https://github.com/kapoost/purrsonality-seller-agent',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    authentication: {
      schemes: ['bearer'],
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [
      {
        id: 'get_products',
        name: 'Discover inventory',
        description: 'Returns available display products matching a brief + promoted offering',
        tags: ['adcp', 'sales-non-guaranteed', 'discovery'],
        examples: [
          'Find display ads for cat owners on the result page',
          "Discover non-guaranteed display inventory matching brief 'premium pet products'",
          'What inventory do you have for organic pet food brands?',
        ],
      },
      {
        id: 'list_creative_formats',
        name: 'List supported creative formats',
        description: 'Returns the creative formats this seller accepts (display 300x250, display responsive)',
        tags: ['adcp', 'creative'],
        examples: [
          'What creative sizes do you accept?',
          'List supported display format specs',
        ],
      },
      {
        id: 'sync_creatives',
        name: 'Submit creatives',
        description: 'Upload creative assets for an approved media buy',
        tags: ['adcp', 'creative', 'lifecycle'],
        examples: [
          'Upload my 300x250 banner for media buy mb_abc123',
          'Submit creative assets with click URL and impression tracker',
        ],
      },
      {
        id: 'list_creatives',
        name: 'List submitted creatives',
        description: 'Returns creatives previously synced for the calling principal',
        tags: ['adcp', 'creative'],
        examples: [
          'Show creatives I previously submitted',
          'List my approved creatives sorted by recency',
        ],
      },
      {
        id: 'create_media_buy',
        name: 'Create media buy',
        description: 'Books inventory for a buyer-specified flight window, budget, and pricing model',
        tags: ['adcp', 'sales-non-guaranteed', 'media-buy', 'lifecycle'],
        examples: [
          'Book the cat quiz result slot for $5000 from June 1 to June 30 at $1.50 CPM',
          'Reserve display inventory for product launch — premium pet food, flight Jul 1–15',
        ],
      },
      {
        id: 'update_media_buy',
        name: 'Update media buy',
        description: 'Modifies an existing media buy (pause, resume, budget change)',
        tags: ['adcp', 'media-buy', 'lifecycle'],
        examples: [
          'Pause media buy mb_abc123',
          'Increase budget on mb_abc123 to $7500',
          'Resume the paused campaign for hipster cat owners',
        ],
      },
      {
        id: 'get_media_buys',
        name: 'List media buys',
        description: 'Returns media buys owned by the calling principal',
        tags: ['adcp', 'media-buy'],
        examples: [
          'List my active media buys',
          'Show all media buys I have on this seller',
        ],
      },
      {
        id: 'get_media_buy_delivery',
        name: 'Get delivery report',
        description: 'Returns spend, impressions, and clicks for a media buy over a date range',
        tags: ['adcp', 'media-buy', 'reporting'],
        examples: [
          'Get delivery report for mb_abc123 from June 1 to June 15',
          'How much have I spent on the hipster campaign this week?',
        ],
      },
      {
        id: 'list_accounts',
        name: 'List seller accounts',
        description: 'Returns publisher account(s) this seller represents (single-publisher: Purrsonality)',
        tags: ['adcp', 'accounts'],
        examples: [
          'What publisher accounts does this seller represent?',
          'List the properties this agent sells inventory for',
        ],
      },
      {
        id: 'get_adcp_capabilities',
        name: 'Capabilities discovery',
        description: 'Returns AdCP version, supported protocols, and per-feature feature flags',
        tags: ['adcp', 'discovery'],
        examples: [
          'What AdCP version is this agent on?',
          'Tell me your feature flags and supported protocols',
        ],
      },
    ],
  };
}
