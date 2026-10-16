import { cloneDeep } from 'lodash';
import { config } from 'src/config.js';
import { spec } from '../../../modules/stackupBidAdapter.ts';

const DEFAULT_ENDPOINT = 'https://adserver.stackup-ai.com/openrtb2/auction';
const CUSTOM_ENDPOINT = 'https://pbs.example.com/openrtb2/auction';

const bannerBidRequestBase = {
  adUnitCode: 'banner-ad-unit-code',
  auctionId: 'auction-id',
  bidId: 'banner-bid-id',
  bidder: 'stackup',
  bidderRequestId: 'bidder-request-id',
  mediaTypes: { banner: { sizes: [[300, 250]] } },
  params: { tag: 'test-tag' },
};

const videoBidRequestBase = {
  adUnitCode: 'video-ad-unit-code',
  auctionId: 'auction-id',
  bidId: 'video-bid-id',
  bidder: 'stackup',
  bidderRequestId: 'bidder-request-id',
  mediaTypes: {
    video: {
      context: 'instream',
      playerSize: [[1920, 1080]],
      mimes: ['video/mp4'],
      protocols: [2, 3, 7],
    },
  },
  params: { tag: 'test-tag' },
};

const bannerServerResponseBase = {
  body: {
    id: 'response-id',
    cur: 'USD',
    seatbid: [{
      seat: 'stackup',
      bid: [{
        id: 'banner-bid',
        impid: 'banner-bid-id',
        price: 1.5,
        adm: '<div>banner-ad</div>',
        adomain: ['advertiser.com'],
        crid: 'banner-creative-id',
        w: 300,
        h: 250,
        mtype: 1,
      }],
    }],
  },
};

const VAST_XML = '<VAST version="4.2"><Ad id="test-ad"><InLine></InLine></Ad></VAST>';

const videoServerResponseBase = {
  body: {
    id: 'response-id',
    cur: 'USD',
    seatbid: [{
      seat: 'stackup',
      bid: [{
        id: 'video-bid',
        impid: 'video-bid-id',
        price: 12,
        adm: VAST_XML,
        adomain: ['advertiser.com'],
        crid: 'video-creative-id',
        w: 1920,
        h: 1080,
        mtype: 2,
      }],
    }],
  },
};

function bidderRequestFor(bidRequests) {
  return {
    bids: bidRequests,
    auctionId: 'auction-id',
    bidderRequestId: 'bidder-request-id',
    ortb2: { site: { page: 'https://example.com' } },
  };
}

describe('Stackup bid adapter', () => {
  let bannerBidRequest;
  let videoBidRequest;

  beforeEach(() => {
    bannerBidRequest = cloneDeep(bannerBidRequestBase);
    videoBidRequest = cloneDeep(videoBidRequestBase);
  });

  afterEach(() => {
    config.resetConfig();
  });

  describe('spec', () => {
    it('has the required properties', () => {
      expect(spec).to.have.property('code', 'stackup');
      expect(spec.supportedMediaTypes).to.have.members(['banner', 'video']);
      expect(spec.isBidRequestValid).to.be.a('function');
      expect(spec.buildRequests).to.be.a('function');
      expect(spec.interpretResponse).to.be.a('function');
    });
  });

  describe('isBidRequestValid', () => {
    it('accepts a valid tag', () => {
      expect(spec.isBidRequestValid(bannerBidRequest)).to.be.true;
    });

    it('accepts letters, digits, dash and underscore up to 128 chars', () => {
      bannerBidRequest.params = { tag: 'pbjs-test_ABC123' };
      expect(spec.isBidRequestValid(bannerBidRequest)).to.be.true;
      bannerBidRequest.params = { tag: 'a'.repeat(128) };
      expect(spec.isBidRequestValid(bannerBidRequest)).to.be.true;
    });

    it('rejects missing params', () => {
      bannerBidRequest.params = undefined;
      expect(spec.isBidRequestValid(bannerBidRequest)).to.be.false;
    });

    it('rejects a missing tag', () => {
      bannerBidRequest.params = { placementId: 'test-tag' };
      expect(spec.isBidRequestValid(bannerBidRequest)).to.be.false;
    });

    [
      ['a number', 123],
      ['a boolean', true],
      ['an object', {}],
      ['an array', []],
      ['null', null],
      ['an empty string', ''],
    ].forEach(([description, tag]) => {
      it(`rejects a tag that is ${description}`, () => {
        bannerBidRequest.params = { tag };
        expect(spec.isBidRequestValid(bannerBidRequest)).to.be.false;
      });
    });

    it('rejects a tag with disallowed characters', () => {
      bannerBidRequest.params = { tag: 'bad tag/1' };
      expect(spec.isBidRequestValid(bannerBidRequest)).to.be.false;
    });

    it('rejects a tag longer than 128 chars', () => {
      bannerBidRequest.params = { tag: 'a'.repeat(129) };
      expect(spec.isBidRequestValid(bannerBidRequest)).to.be.false;
    });
  });

  describe('buildRequests', () => {
    it('sends one POST to the production endpoint by default', () => {
      const request = spec.buildRequests([bannerBidRequest], bidderRequestFor([bannerBidRequest]));

      expect(request.method).to.equal('POST');
      expect(request.url).to.equal(DEFAULT_ENDPOINT);
      expect(request.data.site.page).to.equal('https://example.com');
    });

    it('uses the endpoint from stackup config', () => {
      config.setConfig({ stackup: { endpoint: CUSTOM_ENDPOINT } });
      const request = spec.buildRequests([bannerBidRequest], bidderRequestFor([bannerBidRequest]));

      expect(request.url).to.equal(CUSTOM_ENDPOINT);
    });

    it('ignores an endpoint that is not an http(s) URL', () => {
      config.setConfig({ stackup: { endpoint: 'javascript:alert(1)' } });
      const request = spec.buildRequests([bannerBidRequest], bidderRequestFor([bannerBidRequest]));

      expect(request.url).to.equal(DEFAULT_ENDPOINT);
    });

    it('puts the tag at imp.ext.prebid.bidder.stackup (singular "bidder")', () => {
      const request = spec.buildRequests([bannerBidRequest], bidderRequestFor([bannerBidRequest]));
      const imp = request.data.imp[0];

      expect(imp.ext.prebid.bidder.stackup).to.deep.equal({ tag: 'test-tag' });
      expect(imp.ext.prebid).to.not.have.property('bidders');
    });

    it('builds a banner imp', () => {
      const request = spec.buildRequests([bannerBidRequest], bidderRequestFor([bannerBidRequest]));
      const imp = request.data.imp[0];

      expect(imp.id).to.equal('banner-bid-id');
      expect(imp.banner.format).to.deep.equal([{ w: 300, h: 250 }]);
    });

    if (FEATURES.VIDEO) {
      it('builds a video imp', () => {
        const request = spec.buildRequests([videoBidRequest], bidderRequestFor([videoBidRequest]));
        const imp = request.data.imp[0];

        expect(imp.id).to.equal('video-bid-id');
        expect(imp.video).to.include({ w: 1920, h: 1080 });
        expect(imp.video.mimes).to.deep.equal(['video/mp4']);
      });
    }

    it('sends every ad unit as an imp of a single request', () => {
      videoBidRequest.params = { tag: 'other-tag' };
      const bids = [bannerBidRequest, videoBidRequest];
      const request = spec.buildRequests(bids, bidderRequestFor(bids));

      expect(request).to.not.be.an('array');
      expect(request.data.imp).to.have.length(2);
      expect(request.data.imp[0].id).to.equal('banner-bid-id');
      expect(request.data.imp[1].id).to.equal('video-bid-id');
      expect(request.data.imp[1].ext.prebid.bidder.stackup.tag).to.equal('other-tag');
    });
  });

  describe('interpretResponse', () => {
    it('parses a banner bid', () => {
      const request = spec.buildRequests([bannerBidRequest], bidderRequestFor([bannerBidRequest]));
      const { bids } = spec.interpretResponse(cloneDeep(bannerServerResponseBase), request);

      expect(bids).to.have.length(1);
      expect(bids[0]).to.include({
        requestId: 'banner-bid-id',
        cpm: 1.5,
        currency: 'USD',
        mediaType: 'banner',
        width: 300,
        height: 250,
        creativeId: 'banner-creative-id',
        ad: '<div>banner-ad</div>',
        netRevenue: true,
        ttl: 300,
      });
      expect(bids[0].meta.advertiserDomains).to.deep.equal(['advertiser.com']);
    });

    if (FEATURES.VIDEO) {
      it('parses a video bid', () => {
        const request = spec.buildRequests([videoBidRequest], bidderRequestFor([videoBidRequest]));
        const { bids } = spec.interpretResponse(cloneDeep(videoServerResponseBase), request);

        expect(bids).to.have.length(1);
        expect(bids[0]).to.include({
          requestId: 'video-bid-id',
          cpm: 12,
          mediaType: 'video',
          vastXml: VAST_XML,
          creativeId: 'video-creative-id',
        });
      });
    }

    it('returns no bids for a no-fill (empty seatbid)', () => {
      const request = spec.buildRequests([bannerBidRequest], bidderRequestFor([bannerBidRequest]));
      const result = spec.interpretResponse({ body: { id: 'response-id', seatbid: [] } }, request);

      expect(result.bids ?? result).to.have.length(0);
    });

    it('returns no bids for an empty body (HTTP 204)', () => {
      const request = spec.buildRequests([bannerBidRequest], bidderRequestFor([bannerBidRequest]));

      expect(spec.interpretResponse({ body: undefined }, request)).to.deep.equal([]);
    });
  });
});
