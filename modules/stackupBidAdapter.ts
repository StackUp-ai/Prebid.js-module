import { ortbConverter } from '../libraries/ortbConverter/converter.js';
import { pbsExtensions } from '../libraries/pbsExtensions/pbsExtensions.js';
import { BidderSpec, registerBidder } from '../src/adapters/bidderFactory.js';
import { config } from '../src/config.js';
import { BANNER, VIDEO } from '../src/mediaTypes.js';
import { logWarn } from '../src/utils.js';

interface StackupBidParams {
  /**
   * Supply tag ID assigned to this ad placement.
   */
  tag: string;
}

interface StackupConfig {
  /**
   * Overrides the auction endpoint.
   */
  endpoint?: string;
}

declare module '../src/adUnits' {
  interface BidderParams {
    [BIDDER_CODE]: StackupBidParams;
  }
}

declare module '../src/config' {
  interface Config {
    [BIDDER_CODE]?: StackupConfig;
  }
}

const BIDDER_CODE = 'stackup';
const DEFAULT_ENDPOINT = 'https://adserver.stackup-ai.com/openrtb2/auction';
const DEFAULT_TTL = 300;
const TAG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// pbsExtensions places the bidder params at imp.ext.prebid.bidder.stackup.
const converter = ortbConverter<typeof BIDDER_CODE>({
  context: {
    netRevenue: true,
    ttl: DEFAULT_TTL,
  },
  processors: pbsExtensions,
});

const resolveEndpoint = (): string => {
  const endpoint = config.getConfig(BIDDER_CODE)?.endpoint;
  if (endpoint == null) {
    return DEFAULT_ENDPOINT;
  }
  if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint)) {
    logWarn(`${BIDDER_CODE}: ignoring invalid endpoint override "${endpoint}"`);
    return DEFAULT_ENDPOINT;
  }
  return endpoint;
};

const isBidRequestValid: BidderSpec<typeof BIDDER_CODE>['isBidRequestValid'] = (request) => {
  const tag = request.params?.tag;
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
    logWarn(`${BIDDER_CODE}: params.tag must match ${TAG_PATTERN}, got`, tag);
    return false;
  }
  return true;
};

// One request per auction: every valid ad unit becomes an imp of a single
// OpenRTB request.
const buildRequests: BidderSpec<typeof BIDDER_CODE>['buildRequests'] = (validBidRequests, bidderRequest) => {
  const data = converter.toORTB({
    bidRequests: validBidRequests,
    bidderRequest,
  });

  return {
    url: resolveEndpoint(),
    method: 'POST',
    data,
  };
};

const interpretResponse: BidderSpec<typeof BIDDER_CODE>['interpretResponse'] = (serverResponse, request) => {
  if (!serverResponse?.body) {
    return [];
  }
  return converter.fromORTB({
    response: serverResponse.body,
    request: request.data,
  });
};

export const spec: BidderSpec<typeof BIDDER_CODE> = {
  code: BIDDER_CODE,
  supportedMediaTypes: [BANNER, VIDEO],
  isBidRequestValid,
  buildRequests,
  interpretResponse,
};

registerBidder(spec);
