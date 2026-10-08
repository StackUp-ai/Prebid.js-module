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

# Bid params

| Name  | Scope    | Description                       | Example        | Type     |
|-------|----------|------------------------------------|----------------|----------|
| `tag` | required | Supply tag ID for this placement   | `'seed-tag-1'` | `string` |

# Endpoint

Defaults to production (`https://adserver.stackup-ai.com/openrtb2/auction`).
Override it per environment:

```js
pbjs.setBidderConfig({
  bidders: ['stackup'],
  config: {
    stackup: {
      endpoint: 'http://localhost:8000/openrtb2/auction'
    }
  }
});
```

# Test parameters

```js
const adUnits = [
  {
    code: 'video-1',
    mediaTypes: {
      video: {
        context: 'instream',
        playerSize: [[1920, 1080]],
        mimes: ['video/mp4'],
        protocols: [2, 3, 7]
      }
    },
    bids: [{
      bidder: 'stackup',
      params: { tag: 'seed-tag-1' }
    }]
  },
  {
    code: 'banner-1',
    mediaTypes: {
      banner: { sizes: [[300, 250]] }
    },
    bids: [{
      bidder: 'stackup',
      params: { tag: 'seed-tag-1' }
    }]
  }
];
```
