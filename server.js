const { NanoresourcePromise: Nanoresource } = require('nanoresource-promise/emitter')
const Client = require('./client')
const DHubClient = require('@dhub/client')
const DWebTree = require('dwebtree')
const ddrive = require('ddrive')

const RPC = require('./rpc')
const getNetworkOptions = require('./rpc/socket.js')

const DB_NAMESPACE = 'dhub-mirroring-service'
const DB_VERSION = 'v1'
const BASES_SUB = 'bases'
const TYPES_SUB = 'types'

module.exports = class MirroringService extends Nanoresource {
  constructor (opts = {}) {
    super()
    this.server = RPC.createServer(opts.server, this._onConnection.bind(this))
    this.mirroring = new Set()
    this.downloads = new Map()
    this.dhClient = null
    this.db = null

    this._corestore = null
    this._socketOpts = getNetworkOptions(opts)
  }

  // Nanoresource Methods

  async _open () {
    let running = false
    try {
      const client = new Client({ ...this._socketOpts, noRetry: true })
      await client.ready()
      running = true
    } catch (_) {}
    if (running) throw new Error('A mirroring server is already running on that host/port.')

    this.dhClient = new DHubClient()
    await this.dhClient.ready()
    this._corestore = this.dhClient.basestore(DB_NAMESPACE)

    const rootDb = new DWebTree(this._corestore.default(), {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    }).sub(DB_VERSION)
    await rootDb.ready()
    this.basesDb = rootDb.sub(BASES_SUB)
    this.typesDb = rootDb.sub(TYPES_SUB)

    await this.server.listen(this._socketOpts)
    return this._restartMirroring()
  }

  async _close () {
    await this.server.close()
    for (const { base, request } of this.downloads.values()) {
      base.undownload(request)
    }
    this.downloads.clear()
    this.mirroring.clear()
    await this.dhClient.close()
  }

  // Mirroring Methods

  async _getDriveBases (key, replicate) {
    const drive = ddrive(this._corestore, key)
    drive.on('error', noop)
    await drive.promises.ready()
    if (replicate) await this.dhClient.replicate(drive.metadata)
    return new Promise((resolve, reject) => {
      drive.getContent((err, content) => {
        if (err) return reject(err)
        return resolve({ content, metadata: drive.metadata })
      })
    })
  }

  async _restartMirroring () {
    for await (const { key } of this.basesDb.createReadStream()) {
      await this._mirrorBase(key)
    }
  }

  async _mirrorBase (key, base, noReplicate) {
    base = base || this._corestore.get(key)
    await base.ready()
    if (!noReplicate) await this.dhClient.replicate(base)
    const keyString = (typeof key === 'string') ? key : key.toString('hex')
    this.downloads.set(keyString, {
      base,
      request: base.download()
    })
    // TODO: What metadata should we store?
    await this.basesDb.put(keyString, {})
    this.mirroring.add(keyString)
  }

  // TODO: Make mount-aware
  async _mirrorDrive (key) {
    const { content, metadata } = await this._getDriveBases(key, true)
    return Promise.all([
      this._mirrorBase(metadata.key, metadata, true),
      this._mirrorBase(content.key, content, true)
    ])
  }

  async _unmirrorBase (key, noUnreplicate) {
    const keyString = (typeof key === 'string') ? key : key.toString('hex')
    if (!this.downloads.has(keyString)) return
    const { base, request } = this.downloads.get(keyString)
    if (!noUnreplicate) {
      await this.dhClient.network.configure(base.discoveryKey, {
        announce: false
      })
    }
    base.undownload(request)
    this.downloads.delete(keyString)
    this.mirroring.delete(keyString)
    return this.basesDb.del(keyString)
  }

  // TODO: Make mount-aware
  async _unmirrorDrive (key) {
    const keyString = (typeof key === 'string') ? key : key.toString('hex')
    if (!this.downloads.has(keyString)) return
    const { metadata, content } = await this._getDriveBases(key)
    await this.dhClient.network.configure(metadata.discoveryKey, {
      announce: false
    })
    return Promise.all([
      this._unmirrorBase(metadata.key),
      this._unmirrorBase(content.key)
    ])
  }

  async _mirror ({ key, type }) {
    if (typeof key === 'string') key = Buffer.from(key, 'hex')
    if (!type || type === 'ddatabase') await this._mirrorBase(key)
    else if (type === 'ddrive') await this._mirrorDrive(key)
    await this.typesDb.put(key.toString('hex'), type)
    return this._status({ key, type })
  }

  async _unmirror ({ key, type }) {
    if (typeof key === 'string') key = Buffer.from(key, 'hex')
    if (!type || type === 'ddatabase') await this._unmirrorBase(key)
    else if (type === 'ddrive') await this._unmirrorDrive(key)
    await this.typesDb.del(key.toString('hex'))
    return this._status({ key, type })
  }

  // Info Methods

  _status ({ key, type }) {
    const keyString = (typeof key === 'string') ? key : key.toString('hex')
    return {
      key,
      type,
      mirroring: this.mirroring.has(keyString)
    }
  }

  async _list () {
    const mirroring = []
    for await (const { key, value: type } of this.typesDb.createReadStream()) {
      mirroring.push({
        type,
        key: Buffer.from(key, 'hex'),
        mirroring: true
      })
    }
    return {
      mirroring
    }
  }

  // Connection Handling

  _onConnection (client) {
    this.emit('client-open', client)
    client.on('close', () => {
      this.emit('client-close', client)
    })
    client.mirror.onRequest({
      mirror: this._mirror.bind(this),
      unmirror: this._unmirror.bind(this),
      status: this._status.bind(this),
      list: this._list.bind(this),
      stop: this._close.bind(this)
    })
  }
}

function noop () {}
