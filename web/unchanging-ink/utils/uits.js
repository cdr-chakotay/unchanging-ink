import SHA3 from 'sha3'
import { encodeCanonical } from 'cbor'
import { sleep } from './misc'

const DEFAULT_OPTIONS_GET_TIMESTAMP = {
  wait: false,
  maxRetries: 5,
  firstStepCallback: async () => null,
}

const DEFAULT_OPTIONS_VERIFY_TIMESTAMP = {
  online: true,
}

const DEFAULT_OPTIONS_GET_PROOF = {
  maxRetries: 5,
}

// Case-sensitive v1
const COMPACT_TS_RE =
  /^(?<authority>(?:[hH][tT][tT][pP][sS]?:\/\/)?[[\]0-9a-z_.:-]+(?::[0-9]+)?)\/(?<interval>[0-9]+)#v1(?=[:,])(?::(?<mth>[a-zA-Z0-9_-]+))?(?:,(?<timestamp>[^,]+),(?<proof>[a-zA-Z0-9_-]+))?$/

export function parseCompactTs(c) {
  const match = COMPACT_TS_RE.exec(c)
  if (match) {
    return { ...match.groups }
  }
}

function canonizeAuthority(s) {
  if (!s) {
    return
  }
  let retval = s.replace(/\/*$/, '')
  if (retval.toLowerCase().startsWith('https://')) {
    retval = retval.replace(/^https:\/\//i, '')
    if (retval.endsWith(':443')) {
      retval = retval.replace(/:443/, '')
    }
  }

  return retval.toLowerCase()
}

export function createTimestampHash(data, timestamp) {
  const tsStruct = {
    data,
    timestamp,
    typ: 'ts',
    version: '1',
  }
  return new SHA3(256).update(encodeCanonical(tsStruct)).digest()
}

/**
 * This function creates the hash out of the interval tree head.
 * Therefore, it combines the interval, timestamp and ith into the Interval Tree Head Representation.
 * Its return value is a Buffer containing the ihash - Hash of the Interval Tree Head Representation.
 * @param interval Interval, which the interval tree belongs to
 * @param timestamp Timestamp in ISO 8601 format out of the proof object
 * @param ith Hash of the interval tree (SHA3-256)
 */
function createIHash(interval, timestamp, ith){
  const ith_buf = Buffer.from(ith, 'base64')
  const intervalTreeHeadStruct = {
    interval,
    timestamp,
    ith: ith_buf,
    typ: 'it',
    version: '1',
  }
  return new SHA3(256).update(encodeCanonical(intervalTreeHeadStruct)).digest()

}

// FIXME: maybe use a proper library to avoid errors. Like https://github.com/brianloveswords/base64-url
/**
 * Encodes the given buffer into a Base64URL-encoded string.
 *
 * @param {Buffer} buf - The buffer to encode.
 * @return {string} The Base64URL-encoded string.
 */
 export function base64UrlEncode(buf) {
    const b64 = Buffer.from(buf).toString('base64')
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

/**
 * Decodes a given Base64 URL encoded string.
 *
 * @param {string} s - The Base64 URL encoded string to decode. If the input is falsy, it returns an empty Buffer.
 * @return {Buffer} The decoded content as a Buffer.
 */
 export function base64UrlDecode(s) {
    if (!s) return Buffer.alloc(0)

    // Swap back
    let b64 = s.replace(/-/g, '+').replace(/_/g, '/')

    // Pad to multiple of 4
    b64 += '='.repeat((4 - (b64.length % 4)) % 4)
    return Buffer.from(b64, 'base64')
}

function _verifyInclusionProof({ hash, head, a, path }) {
  let current = new SHA3(256)
    .update(Buffer.from([0]))
    .update(hash)
    .digest()
  let i = 0
  for (const node of path) {
    console.log(i, a)
    i = i + 1
    if ((a & 1) !== 0) { // path bit is 1, current node is right side and other node is left side
      current = new SHA3(256)
        .update(Buffer.from([1]))
        .update(node)
        .update(current)
        .digest()
    } else {
      current = new SHA3(256)
        .update(Buffer.from([1]))
        .update(current)
        .update(node)
        .digest()
    }
    a >>= 1
  }
  // TODO: Remove
  console.log(current, head)
  console.log(current.toString('base64'), head.toString('base64'))
  return current.compare(head) === 0
}

/**
 * Verify a timestamp proof
 * @param hash Hash of timestamp nucleus, a Buffer
 * @param ith Interval tree hash, base64
 * @param a Node address, see protocol documentation, Number
 * @param path Node path, see protocol documentation, Array of base64
 * @returns {boolean} True iff hash is verified to be included in ith, per a and path
 */
function verifyTsProof(hash, { ith, a, path }) {
  return _verifyInclusionProof({
    hash,
    head: Buffer.from(ith, 'base64'),
    a,
    path: path.map((item) => Buffer.from(item, 'base64')),
  })
}

function verifyIntervalProof(ihash, mth, { a, nodes }) {
  return _verifyInclusionProof({
    hash: ihash,
    head: mth, // It is already a Buffer
    a,
    path: nodes.map((item) => Buffer.from(item, 'base64')),
  })
}

const SOURCE_DIRECT_SET = 'direct'

class InconsistencyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InconsistencyError'
  }
}

class TimestampServerError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TimestampServerError'
  }
}

export class TimestampService {
  constructor(authority) {
    this.authority = canonizeAuthority(authority)
    this.baseUrl =
      (!this.authority.includes('://') ? 'https://' : '') +
      this.authority +
      '/api/'

    this.cacheIth = {}
    this.cacheMtree = {}
    this.knownHead = {
      interval: null,
      mth: null,
    }
    this.ws = null
    this.tickItems = []
    this._listeners = {}
    this._listener_next_idx = 0
    console.log(
      `Created new TimestampService for ${this.authority} at ${this.baseUrl}`
    )
  }

  addListener(f) {
    const idx = this._listener_next_idx
    this._listeners[idx] = f
    this._listener_next_idx++
    return idx
  }

  removeListener(idx) {
    delete this._listeners[idx]
  }

  callListeners(item) {
    for (const listener of Object.values(this._listeners)) {
      listener(item)
    }
  }

  updateState(authority, type, data) {
    if (canonizeAuthority(authority) !== this.authority) {
      throw new InconsistencyError('Authority mismatch')
    }
    if (type === 'mh') {
      const { mh } = data
      if (
        !this.knownHead?.interval ||
        this.knownHead.interval < mh.interval.index
      ) {
        this.knownHead = {
          interval: mh.interval.index,
          mth: Buffer.from(mh.mth, 'base64'),
        }
      }
      this.cacheIth[mh.interval.index] = Buffer.from(mh.interval.ith, 'base64')
      this.cacheMtree[`0-${mh.interval.index + 1}`] = Buffer.from(
        mh.mth,
        'base64'
      )
    }
  }

  openLiveConnection() {
    if (this.ws) {
      this.closeLiveConnection()
    }
    this.ws = new WebSocket(
      this.baseUrl.replace(/^http/i, 'ws') + 'v1/mth/live'
    )
    this.ws.onmessage = (event) => this._wsmessage(event)
    this.ws.onclose = (event) => this._wsclose(event)
  }

  _wsmessage(event) {
    const data = JSON.parse(event?.data ?? '')
    this.tick(data)
  }

  _wsclose() {
    // FIXME multiple retries?
    console.log('Live socket is closed, trying to reconnect in 10s')
    this.closeLiveConnection()
    setTimeout(() => {
      this.openLiveConnection()
    }, 10000)
  }

  tick(mh, preload = false) {
    const item = {
      time: mh?.interval?.timestamp ?? 'not set',
      hash: mh?.mth ?? 'NOT SET',
      icon: (String(mh?.interval?.index ?? '?')).match(/.{1,3}/g).join('\n'),
    }

    item.timeobj = new Date(mh.timestamp)
    item.received = preload ? item.timeobj : new Date()

    this.updateState(mh.authority, 'mh', {
      mh,
      received: item.received,
    })

    this.tickItems.unshift(item)
    if (this.tickItems.length > 5) {
      this.tickItems.pop()
    }
    this.callListeners(item)
    return true
  }

  get averageTickDurationMillis() {
    const diffs = this.tickItems
      .slice(1)
      .map((v, i) => this.tickItems[i].received - v.received)
      .filter((v) => v >= 1000)
    if (diffs.length > 0) {
      return diffs.reduce((partial, v) => partial + v, 0) / diffs.length
    }
    return 5000.0
  }

  get estimatedNextTick() {
    const lastTick = this.lastTick
    if (!lastTick) {
      return null
    }
    return new Date(lastTick.getTime() + this.averageTickDurationMillis)
  }

  get lastTick() {
    if (this.tickItems && this.tickItems.length > 0) {
      return this.tickItems[0].received
    }
    return null
  }

  closeLiveConnection() {
    if (this.ws) {
      this.ws.onclose = undefined
      this.ws.close()
      delete this.ws
      this.ws = null
    }
  }

  setTrusted(url, source = SOURCE_DIRECT_SET) {
    const parsedUrl = parseCompactTs(url)
    if (parsedUrl) {
      this.knownHead = {
        interval: parseInt(parsedUrl.interval),
        mth: parsedUrl.mth,
        source,
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  amendTree(extensionProof) {}

  async getTimestamp(data, options = DEFAULT_OPTIONS_GET_TIMESTAMP) {
    const request = { data }
    const options_ = { ...DEFAULT_OPTIONS_GET_TIMESTAMP, ...options }
    let response = await fetch(
      this.baseUrl + 'v1/ts/' + (options_.wait ? '?wait' : ''),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(request),
      }
    )
    let ts = null
    if (response) {
      ts = await response.json()
    }
    if (!response || !ts || !ts.id) {
      throw new TimestampServerError('null response from server')
    }
    if (ts && ts.proof) {
      return ts
    }
    await options_.firstStepCallback()
    let retryCounter = 0
    while (retryCounter < 5 && ts && !ts?.proof) {
      const waitTime = Math.max(
        this.estimatedNextTick - new Date(),
        retryCounter === 0 ? 500 : 1000
      )
      await sleep(waitTime)
      response = await fetch(
        this.baseUrl +
          'v1/ts/' +
          ts.id +
          '/' +
          (retryCounter === 0 ? '?wait' : ''),
        {
          headers: {
            Accept: 'application/json',
          },
        }
      )
      if (response) {
        ts = await response.json()
      }
      retryCounter++
    }
    if (ts && ts.proof) {
      const components = parseCompactTs(ts.proof.mth)
      this.updateState(components.authority, 'mth', {
        interval: components.interval,
        mth: components.mth,
        ith: ts.proof.ith,
        received: new Date(),
      })
      return ts
    }
    throw new TimestampServerError('Timed out waiting for interval from server')
  }

  async verifyTimestamp(data, ts, options = DEFAULT_OPTIONS_VERIFY_TIMESTAMP) {
    const hash = createTimestampHash(data, ts.timestamp)
    if (ts?.hash) {
      if (Buffer.from(ts.hash, 'base64').compare(hash) !== 0) {
        return false
      }
    }
    return verifyTsProof(hash, ts.proof)
  }

  async verifyIntervalInclusion(ts, inclusion_proof){
    const ihash = createIHash(ts.interval, ts.timestamp, ts.proof.ith)

    // Extract mth from url encoded mth inside the proof. Keep Buffer, as we need it downstream
    const mth = base64UrlDecode(ts.proof.mth.match(/[^:]+$/i)[0])

    return verifyIntervalProof(ihash, mth, inclusion_proof)

  }


  async getInclusionProof(ith_interval, mth_interval, options = DEFAULT_OPTIONS_GET_PROOF) {
    // cast both intervals to int
    ith_interval = parseInt(ith_interval)
    mth_interval = parseInt(mth_interval)
    if(ith_interval < 0 || mth_interval < 0) {
        throw new Error('Invalid interval: ith and mth must be >= 0')
    }

    if(ith_interval > mth_interval) {
      throw new Error('Invalid interval: ith must be <= mth')
    }

    const input_url = this.baseUrl + 'v1/mth/' + ith_interval + '/in/' + mth_interval
    const headers = { Accept: 'application/json' }

    let proof = await this._fetchProof(input_url, headers, options)
    console.log(proof)
    return proof
    }



  async _fetchProof(url, headers, options) {
    let attempts = options.maxRetries
    let response = await fetch(url, { headers })
    if (response.ok) {
      return await response.json()
    } else {
      // Retry if we have not reached the maximum number of attempts
      while (attempts > 0) {
        // wait a random time between 0 and 1000ms before retrying
        await sleep(Math.floor(Math.random() * 1000))
        attempts--
        response = await fetch(url, { headers })
        if (response.ok) {
          return await response.json()
        }
      }
    }
    throw new Error(`Failed to fetch proof after ${options.maxRetries} attempts. Status code: ${response.status}, Error: ${response.statusText}`)
  }


  async getCachedMthForInterval(interval, urlsafe = true) {
    let mth = this.cacheMtree[`0-${interval + 1}`]
    if (!mth) {
      return null
    }
    // Make url safe base64

    let mth_base64 = Buffer.from(mth)
    if (urlsafe) {
      mth_base64 = base64UrlEncode(mth_base64)
    } else {
      mth_base64 = mth_base64.toString('base64')
    }
    return mth_base64
  }
}
