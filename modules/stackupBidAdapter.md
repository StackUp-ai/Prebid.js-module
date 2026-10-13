# Stackup Bid Adapter

# Overview

```
Module name: Stackup Bid Adapter
Module Type: Bidder Adapter
Maintainer: anton@stackup-ai.com
```

# Description

Connects to StackUp's Prebid Server. The adapter sends one OpenRTB request per
auction to the standard `/openrtb2/auction` endpoint; StackUp's direct demand
answers for each ad unit's supply tag. Banner and video are supported.

The only bidder param is `tag`, the supply tag ID for this placement
(`[A-Za-z0-9_-]`, up to 128 characters). It is sent as
`imp[].ext.prebid.bidder.stackup.tag`.

The earlier `placementId` param is no longer supported: ad units that still
pass it are rejected by the adapter, and StackUp's Prebid Server rejects it too.

Use the bidder code `stackup` directly. Don't alias it
(`pbjs.aliasBidder('stackup', …)`): an alias moves the params to
`ext.prebid.bidder.<alias>`, where StackUp's Prebid Server doesn't look, so
the ad unit gets no bid.

# Bid params

| Name  | Scope    | Description                       | Example                | Type     |
|-------|----------|------------------------------------|------------------------|----------|
| `tag` | required | Supply tag ID for this placement   | `'cascade-web-banner'` | `string` |

# Endpoint

Defaults to production (`https://adserver.stackup-ai.com/openrtb2/auction`).
Override it per environment:

```js
pbjs.setBidderConfig({
  bidders: ['stackup'],
  config: {
    stackup: {
      // staging: 'https://staging-adserver.stackup-ai.com/openrtb2/auction'
      endpoint: 'http://localhost:8000/openrtb2/auction'
    }
  }
});
```

# Video

StackUp returns video bids as inline VAST (`vastXml`), with no `vastUrl`.
Prebid drops vastXml-only video bids unless a cache is configured, so set one
of:

```js
pbjs.setConfig({ cache: { url: 'https://prebid.example.com/pbc/v1/cache' } }); // Prebid Cache
pbjs.setConfig({ cache: { useLocal: true } });                                 // in-browser cache
pbjs.setConfig({ cache: { allowVastXmlOnly: true } });                         // testing only
```

# Test parameters

These tags exist in StackUp Prebid Server's local sample book
(`sample/stackup/entities`) and fill from a desktop browser with no extra
signals. Tags created in the back office work the same way, subject to their
line items' targeting.

```js
const adUnits = [
  {
    code: 'video-1',
    mediaTypes: {
      video: {
        context: 'instream',
        playerSize: [[640, 480]],
        mimes: ['video/mp4'],
        protocols: [2, 3, 5, 6]
      }
    },
    bids: [{
      bidder: 'stackup',
      params: { tag: 'cascade-live-preroll' }
    }]
  },
  {
    code: 'banner-1',
    mediaTypes: {
      banner: { sizes: [[300, 250]] }
    },
    bids: [{
      bidder: 'stackup',
      params: { tag: 'cascade-web-banner' }
    }]
  }
];
```
