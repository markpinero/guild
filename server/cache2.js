'use strict'
// 3rd
const debug = require('debug')('app:cache2')
// 1st
const config = require('./config')
const db = require('./db')

////////////////////////////////////////////////////////////

class Cache {
  constructor (clock = global) {
    // Let us inject a clock for testing
    this.clock = clock
    // Set of keys that are currently running their step() function
    this.locks = new Set()
    // Mapping of key to {ms, step, lastRun, value}
    this.tasks = Object.create(null)
    // Avoids multiple start() calls from starting multiple loops
    this.started = false
  }

  // Starts the update loop and return the cache instance
  start (frequency = 1000) {
    if (this.started) {
      return this
    }
    this.started = true
    this.clock.setInterval(() => this.tick(), frequency)
    return this
  }

  // Check each task's .lastRun timestamp to see if it needs to
  // be step()'ed.
  async tick () {
    const promises = []
    Object.keys(this.tasks).forEach((key) => {
      // Skip tasks that aren't yet due for a refresh
      if (this.clock.Date.now() - this.tasks[key].lastRun < this.tasks[key].ms) {
        return
      }

      promises.push(this.refresh(key))
    })
    return Promise.all(promises)
  }

  get (key) {
    debug(`[get] ${key} = ${this.tasks[key] ? this.tasks[key].value : undefined}`)
    // Handle nonexistent key
    if (!this.tasks[key]) {
      return
    }
    return this.tasks[key].value
  }

  // Synchronous updates
  //
  // These update a task's value and reset the interval.

  set (key, value) {
    debug(`[set] ${key} = ${value}`)
    this.tasks[key].value = value
    this.tasks[key].lastRun = this.clock.Date.now()
    return this
  }

  update (key, xform) {
    return this.set(key, xform(this.get(key)))
  }

  // Trigger asynchronous update

  // Returns Promise<nextValue>
  //
  // Run's the task's step() promise.
  // - Ensures each task is running only once
  // - If .set()/.update() update task's value while step() is running,
  //   the step() result is discarded.
  async refresh (key) {
    debug('[refresh] refreshing', key)
    // Refresh is already in flight, so do nothing
    if (this.locks.has(key)) {
      debug(`[refresh] --bail-- lock taken for ${key}`)
      return
    }

    // Grab lock
    this.locks.add(key)

    const {step, lastRun: prevRun, value: prevValue} = this.tasks[key]

    // If anything goes wrong, our next value is simply our prev value
    let nextValue = prevValue
    try {
      nextValue = await step(prevValue)
    } catch (err) {
      // On error, we do nothing but hope the next interval is more successful
      console.error(`[IntervalCache] Error updating cache key "${key}"`, err)
    } finally {
      // Release lock
      this.locks.delete(key)
    }

    // If lastRun changed while we were step()'ing, then
    // .set() was used, so discard this result and return the fresher value
    if (prevRun !== this.tasks[key].lastRun) {
      debug(`[refresh] --bail-- prevRun !== lastRun`)
      return this.get(key)
    }

    // step() was successful and uninterrupted, so now we can update our state.
    debug(`[refresh] --OK-- setting ${key} = ${nextValue}`)
    this.set(key, nextValue)

    return nextValue
  }

  // Returns Cache instance for chaining
  every (key, ms, step, initValue) {
    // lastRun starts at 0 so that it always runs on first start() loop
    this.tasks[key] = { ms, step, lastRun: 0, value: initValue }
    return this
  }

  once (key, step, initValue) {
    this.tasks[key] = { ms: Date.now(), step, lastRun: 0, value: initValue }
    return this
  }
}

////////////////////////////////////////////////////////////

const cache = new Cache()
  // 10 minutes
  .every('forum-mods', 1000 * 60 * 10, async () => {
    // maps forumId -> [User]
    const mapping = {}
    const rows = await db.allForumMods()
    rows.forEach((row) => {
      if (mapping[row.forum_id]) {
        mapping[row.forum_id].push(row.user)
      } else {
        mapping[row.forum_id] = [row.user]
      }
    })
    return mapping
  }, {})

if (config.FAQ_POST_ID) {
  // 1 hour
  cache.every('faq-post', 1000 * 60 * 60, () => {
    return db.findPostById(config.FAQ_POST_ID)
  })
}

if (config.WELCOME_POST_ID) {
  cache.once('welcome-post', () => {
    return db.findPostById(config.WELCOME_POST_ID)
  })
}

////////////////////////////////////////////////////////////

module.exports = cache.start()
