/** Key checks. A missing key (or MOCK=1) puts that route in mock mode. */
const has = (name: string) => Boolean(process.env[name] && process.env[name]!.trim());

export const isMock = () => process.env.MOCK === '1';
export const hasAnthropic = () => !isMock() && has('ANTHROPIC_API_KEY');
export const hasFal = () => !isMock() && has('FAL_KEY');
export const hasEleven = () => !isMock() && has('ELEVENLABS_API_KEY') && has('ELEVENLABS_AGENT_ID');

export const anthropicModel = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
