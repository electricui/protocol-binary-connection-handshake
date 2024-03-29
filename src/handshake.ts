import debug from 'debug'
import { matchesState, Machine } from 'xstate'
import { CancellationToken } from '@electricui/async-utilities'

import { Connection, Device, DeviceHandshake, DEVICE_EVENTS, Message, Progress } from '@electricui/core'
import { MESSAGEIDS, TYPES } from '@electricui/protocol-binary-constants'
import { AuditLog } from '@electricui/core'

import { mark, measure } from './perf'

const dConnectionHandshakeEvents = debug('electricui-protocol-binary:connection-handshake:events')
const dConnectionHandshakeStateTransitions = debug('electricui-protocol-binary:connection-handshake:state-transitions')
const dConnectionHandshakeProgressUpdates = debug('electricui-protocol-binary:connection-handshake:progress-updates')
const dConnectionHandshakeOutgoing = debug('electricui-protocol-binary:connection-handshake:outgoing')
const dConnectionHandshake = debug('electricui-protocol-binary:connection-handshake:general')

interface Event {
  type: string
  payload?: any
  messageID?: string
}

interface MessageEvent extends Event {
  messageID: string
}

type Dispatch = (event: Event) => void

interface ActionMap {
  [key: string]: (fullState: FullStateShape, event: Event, dispatch: Dispatch) => void
}

export const enum PROGRESS_KEYS {
  FINISHED = 'finished',
  RECEIVED_AMOUNT_OF_MESSAGEIDS = 'received-amount-of-messageids',
  RECEIVED_MESSAGEIDS = 'received-messageids',
  RECEIVED_MESSAGEID = 'received-messageid',
  REQUEST_LIST = 'request-list',
  REQUEST_OBJECTS = 'request-objects',
  REQUEST_INDIVIDUAL = 'request-individual',
  SWITCH_INDIVIDUAL_REQUEST_MODE = 'switch-to-individual-request-mode',
  FAILED = 'failed',
}

export const AUDIT_LOG_BINARY_HANDSHAKE = 'electricui-binary-protocol-handshake'

export enum BINARY_HANDSHAKE_AUDIT_EVENTS {}

const actionMap: ActionMap = {
  requestList: (fullState: FullStateShape, event: Event, dispatch: Dispatch) => {
    mark(`binary-handshake:request-list`)

    fullState.updateProgress(PROGRESS_KEYS.REQUEST_LIST, {
      retries: fullState.retries,
      received: fullState.messageIDsReceived,
    })

    return fullState.sendCallback(fullState.requestListMessageID)
  },
  requestObjects: (fullState: FullStateShape, event: Event, dispatch: Dispatch) => {
    mark(`binary-handshake:request-objects`)

    fullState.updateProgress(PROGRESS_KEYS.REQUEST_OBJECTS, {
      retries: fullState.retries,
    })

    return fullState.sendCallback(fullState.requestObjectsMessageID)
  },
  appendReceived: (fullState: FullStateShape, event: Event, dispatch: Dispatch) => {
    const allSet = new Set(fullState.messageIDsReceived)

    for (const messageID of event.payload) {
      allSet.add(messageID)
    }

    // this will replace our fullState
    fullState.messageIDsReceived = Array.from(allSet.values())

    fullState.updateProgress(PROGRESS_KEYS.RECEIVED_MESSAGEIDS, {
      received: fullState.messageIDsReceived,
      total: fullState.messageIDsReceived.length,
    })
  },
  populateHashmap: (fullState: FullStateShape, event: Event, dispatch: Dispatch) => {
    const allReceived = fullState.messageIDsReceived

    for (const messageID of allReceived) {
      fullState.messageIDObjects.set(messageID, undefined)
    }
  },
  logIndividualRequestMode: (fullState: FullStateShape, event: Event, dispatch: Dispatch) => {
    fullState.updateProgress(PROGRESS_KEYS.SWITCH_INDIVIDUAL_REQUEST_MODE, {
      received: Array.from(fullState.messageIDObjects.entries())
        .filter(entry => entry[1] !== undefined)
        .map(entry => entry[0]),
      waiting: Array.from(fullState.messageIDObjects.entries())
        .filter(entry => entry[1] === undefined)
        .map(entry => entry[0]),
      receivedCount: Array.from(fullState.messageIDObjects.values()).filter(val => val !== undefined).length,
      total: fullState.messageIDsReceived.length,
    })
  },
  requestIndividual: (fullState: FullStateShape, event: Event, dispatch: Dispatch) => {
    const allMessageIDs = fullState.messageIDsReceived

    for (const messageID of allMessageIDs) {
      if (fullState.messageIDObjects.get(messageID) === undefined) {
        fullState.sendQuery(messageID)

        fullState.updateProgress(PROGRESS_KEYS.REQUEST_INDIVIDUAL, {
          messageID,
          retries: fullState.retries,
          received: Array.from(fullState.messageIDObjects.entries())
            .filter(entry => entry[1] !== undefined)
            .map(entry => entry[0]),
          waiting: Array.from(fullState.messageIDObjects.entries())
            .filter(entry => entry[1] === undefined)
            .map(entry => entry[0]),
          receivedCount: Array.from(fullState.messageIDObjects.values()).filter(val => val !== undefined).length,
          total: fullState.messageIDsReceived.length,
        })

        return
      }
    }

    /*
      This is logically impossible, 
      either
        `request_objects_individually` has just been entered, specifically because there were individuals left
        `individualsLeftToRequest` just fired, we have individuals left to request
        a timeout has been called, if a message were received during this time, `allReceivedWhenThisAdded` would avoid this action
    */

    /* istanbul ignore next */
    throw new Error(`All ${allMessageIDs.length} messageIDs had data, why requesting individual?`)
  },
  addObject: (fullState: FullStateShape, event: MessageEvent, dispatch: Dispatch) => {
    if (fullState.messageIDObjects.get(event.messageID) !== undefined) {
      dConnectionHandshake(
        `received ${event.messageID} again, payload was ${fullState.messageIDObjects.get(
          event.messageID,
        )}, and is now ${event.payload}`,
      )
    }

    if (event.payload === undefined) {
      dConnectionHandshake(`Event payload for ${event.messageID} was undefined, setting to null`)
      event.payload = null
    }

    fullState.messageIDObjects.set(event.messageID, event.payload)

    fullState.updateProgress(PROGRESS_KEYS.RECEIVED_MESSAGEID, {
      messageID: event.messageID,
    })
  },
  incrementRetries: (fullState: FullStateShape, event: Event, dispatch: Dispatch) => {
    fullState.retries = fullState.retries + 1
  },
  resetRetries: (fullState: FullStateShape, event: Event, dispatch: Dispatch) => {
    fullState.retries = 0
  },
  onFinish: (fullState: FullStateShape, event: Event, dispatch: Dispatch) => {
    fullState.onFinish()
  },
  onFail: (fullState: FullStateShape, event: Event, dispatch: Dispatch) => {
    fullState.onFail()
  },
}

// Transitions

export const enum TRANSITIONS {
  START = 'START',
  TIMEOUT = 'TIMEOUT',
  RECEIVED_COUNT = 'RECEIVED_COUNT',
  RECEIVED_MESSAGEIDS = 'RECEIVED_MESSAGEIDS',
  RECEIVED_OBJECT = 'RECEIVED_OBJECT',
}

const stateMachine = Machine(
  {
    id: 'binary-handshake',
    initial: 'request_ids',
    key: 'handshake',
    states: {
      request_ids: {
        initial: 'await_list',
        states: {
          await_list: {
            on: {
              // As messageIDs come in, append them
              RECEIVED_MESSAGEIDS: {
                internal: true,
                actions: ['appendReceived'],
              },
              RECEIVED_COUNT: [
                {
                  // If we have received our messageIDs and the correct amount has been received, request the objects
                  cond: 'correctAmountOfMessageIDsRecevied',
                  target: '#handshake.request_objects_bulk',
                },
                {
                  // If we received the count but we haven't received the correct amount of messageIDs, wait for a timeout
                  internal: true,
                  cond: 'belowMaxRetries',
                },
                // If we are not below our maximum retries, fail out.
                { target: '#handshake.fail' },
              ],
              TIMEOUT: [
                {
                  // Retry if below our max retries
                  internal: true,
                  cond: 'belowMaxRetries',
                  actions: ['incrementRetries', 'requestList'],
                },
                // Otherwise fail out
                { target: '#handshake.fail' },
              ],
            },
          },
        },
      },
      request_objects_bulk: {
        initial: 'await_objects',
        // On entry request objects
        onEntry: ['populateHashmap', 'resetRetries', 'requestObjects'],
        states: {
          await_objects: {
            on: {
              // When data comes in
              RECEIVED_OBJECT: [
                {
                  // If this message would cause us to be finished, we're about to be done.
                  // add the object and transition to the finish
                  cond: 'allReceivedWhenThisAdded',
                  actions: ['addObject'],
                  target: '#handshake.finish',
                },
                {
                  // otherwise just add the object and keep waiting
                  actions: ['addObject'],
                  internal: true,
                },
              ],
              TIMEOUT: [
                {
                  // If we haven't received anything yet, try a retry if we can
                  internal: true,
                  cond: 'shouldRetryAll',
                  actions: ['incrementRetries', 'requestObjects'],
                },
                {
                  // If we're out of retries with this method, transition to an individual request / response
                  target: '#handshake.request_objects_individually',
                },
              ],
            },
          },
        },
      },
      request_objects_individually: {
        initial: 'await_object',
        // Ask for our first messageID
        onEntry: ['resetRetries', 'logIndividualRequestMode', 'requestIndividual'],
        states: {
          await_object: {
            on: {
              // Once we receive data
              RECEIVED_OBJECT: [
                {
                  // If this message would cause us to be finished, we're about to be done.
                  // add the object and transition to the finish
                  cond: 'allReceivedWhenThisAdded',
                  actions: ['addObject'],
                  target: '#handshake.finish',
                },
                {
                  // Otherwise there are individuals left to request, request one
                  cond: 'individualsLeftToRequest',
                  actions: ['addObject', 'requestIndividual'],
                  internal: true,
                },
              ],
              TIMEOUT: [
                {
                  // We get n retries globally during this process, if we time out while
                  // waiting for something, see if we can try again
                  internal: true,
                  cond: 'belowMaxRetries',
                  actions: ['incrementRetries', 'requestIndividual'],
                },
                // otherwise fail out
                { target: '#handshake.fail' },
              ],
            },
          },
        },
      },
      finish: {
        onEntry: ['onFinish'],
      },
      fail: {
        onEntry: ['onFail'],
      },
    },
  },
  {
    guards: {
      correctAmountOfMessageIDsRecevied: (fullState: FullStateShape, event) => {
        const ourCount = fullState.messageIDsReceived.length
        const reportedCount = event.payload

        return ourCount === reportedCount
      },
      belowMaxRetries: (fullState: FullStateShape, event) => {
        const retries = fullState.retries
        const maxRetries = fullState.maxRetries

        return retries <= maxRetries
      },
      shouldRetryAll: (fullState: FullStateShape, event) => {
        const retries = fullState.retries
        const maxRetries = fullState.maxRetries

        if (retries > maxRetries) {
          return false
        }

        // if we haven't received anything, retry all
        const allMessageIDs = fullState.messageIDsReceived

        for (const messageID of allMessageIDs) {
          const value = fullState.messageIDObjects.get(messageID)

          if (value !== undefined) {
            return false
          }
        }

        return true
      },
      allReceivedWhenThisAdded: (fullState: FullStateShape, event: MessageEvent) => {
        // and check if we're done
        const allMessageIDs = fullState.messageIDsReceived

        for (const messageID of allMessageIDs) {
          const value = fullState.messageIDObjects.get(messageID)

          // If we have one missing that isn't the one we're about to add
          // we're not finished yet
          if (value === undefined && messageID !== event.messageID) {
            return false
          }
        }

        return true
      },
      individualsLeftToRequest: (fullState: FullStateShape, event) => {
        const allMessageIDs = fullState.messageIDsReceived

        for (const messageID of allMessageIDs) {
          const value = fullState.messageIDObjects.get(messageID)

          if (value === undefined) {
            return true
          }
        }

        /*
          I'm 99% sure this is logically impossible, if there are no messageIDs left to request,
          then the `allReceivedWhenThisAdded` gate would have run before this, 
          preventing this function from running at all, since we would be finished.
        */

        /* istanbul ignore next */
        return false
      },
    },
  },
)

interface FullStateShape {
  requestListMessageID: string
  requestObjectsMessageID: string
  listMessageID: string
  amountMessageID: string
  messageIDsReceived: Array<string>
  messageIDObjects: Map<string, any>
  retries: number
  maxRetries: number

  numberOfMessageIDs: number

  sendCallback: (messageID: string) => Promise<void>
  sendQuery: (messageID: string) => Promise<void>
  updateProgress: (progressKey: PROGRESS_KEYS, meta?: ProgressMeta) => void

  onFinish: () => void
  onFail: () => void

  auditLog: AuditLog
}

interface ConnectionHandshakeOptions {
  device: Device
  cancellationToken: CancellationToken
  timeout?: number
  preset: 'custom' | 'default'
  requestListMessageID?: string
  requestObjectsMessageID?: string
  listMessageID?: string
  amountMessageID?: string
  /**
   * Each progress message can be customised with either a string or a function that receives the retry number
   */
  progressText?: (progressKey: PROGRESS_KEYS, meta: ProgressMeta) => string | null
}

interface HandshakeMessageIDs {
  requestListMessageID: string
  requestObjectsMessageID: string
  listMessageID: string
  amountMessageID: string
}

export interface ProgressMeta {
  messageID?: string
  retries?: number
  total?: number
  receivedCount?: number
  received?: string[]
  waiting?: string[]
}

export default class BinaryConnectionHandshake extends DeviceHandshake {
  currentState = stateMachine.initialState // starts as await_list
  fullState: FullStateShape

  private timeout: number = 1000
  private timeoutSince: number
  private interval: NodeJS.Timer | null = null
  private loopInterval: number = 50
  private lastProgress: number
  private getProgressText: (progressKey: PROGRESS_KEYS, meta: ProgressMeta) => string | null

  constructor(options: ConnectionHandshakeOptions) {
    super(options.device, options.cancellationToken)
    let messageIDs: HandshakeMessageIDs

    // istanbul ignore next
    if (!options.cancellationToken) {
      throw new Error(`Binary Protocol Handshake was created without a CancellationToken`)
    }

    if (options.preset === 'custom') {
      if (
        !options.requestListMessageID ||
        !options.requestObjectsMessageID ||
        !options.amountMessageID ||
        !options.listMessageID
      ) {
        throw new Error('Need to specify all messageIDs when not using a preset with a BinaryConnectionHandshake')
      }

      if (
        new Set([
          options.requestListMessageID,
          options.requestObjectsMessageID,
          options.amountMessageID,
          options.listMessageID,
        ]).size !== 4
      ) {
        throw new Error('Duplicate messageID used in custom setup of BinaryConnectionHandshake.')
      }

      messageIDs = {
        requestListMessageID: options.requestListMessageID,
        requestObjectsMessageID: options.requestObjectsMessageID,
        amountMessageID: options.amountMessageID,
        listMessageID: options.listMessageID,
      }
    } else {
      messageIDs = {
        requestListMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_LIST,
        requestObjectsMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_MESSAGE_OBJECTS,
        listMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_ITEM,
        amountMessageID: MESSAGEIDS.READWRITE_MESSAGEIDS_COUNT,
      }
    }

    this.getProgressText = options.progressText ?? this.defaultProgressText

    this.fullState = {
      ...messageIDs,
      // extended state

      messageIDsReceived: [],
      messageIDObjects: new Map(),
      retries: 0,
      maxRetries: 2,

      numberOfMessageIDs: 0,

      sendCallback: this.sendCallback,
      sendQuery: this.sendQuery,
      updateProgress: this.updateProgress,

      onFinish: this.onFinish,
      onFail: this.onFail,

      auditLog: this.auditLog,
    }

    this.timeout = options.timeout ?? this.timeout
    this.lastProgress = this.getNow()
    this.timeoutSince = this.getNow()
  }

  onSubscribe() {
    this.connect()
  }

  getNow = () => {
    return Date.now()
  }

  dispatch = (event: MessageEvent) => {
    dConnectionHandshakeEvents('EVENT', event)

    // Calculate the next state
    const nextState = stateMachine.transition(this.currentState, event, this.fullState)

    // Action before transition
    nextState.actions.forEach(actionObj => {
      const action = actionMap[actionObj.type]

      // istanbul ignore next
      if (!action) {
        throw new Error(
          `Unknown action (${actionObj.type}) returned as part of event ${JSON.stringify(
            event,
          )}, state change ${JSON.stringify(this.currentState.value)} -> ${JSON.stringify(
            nextState.value,
          )} during binary handshake.`,
        )
      }

      // run the action, they can directly mutate state if they want.
      action(this.fullState, event, this.dispatch)
    })

    dConnectionHandshakeStateTransitions('STATE', this.currentState.value, '->', nextState.value)

    // Commit the transition to the next state
    this.currentState = nextState
  }

  sendCallback = (messageID: string) => {
    dConnectionHandshakeOutgoing('Sent Callback', messageID)

    const callback = new Message(messageID, null)
    callback.metadata.type = TYPES.CALLBACK
    callback.metadata.internal = true
    callback.metadata.query = false

    const cancellationToken = new CancellationToken(`Send Callback for handshake: ${messageID}`)
    // Cancel this callback request if the overarching cancellation token triggers
    this.cancellationToken.subscribe(cancellationToken.cancel)

    return this.device
      .write(callback, cancellationToken)
      .catch(err => {
        // istanbul ignore next
        if (cancellationToken.caused(err)) {
          return
        }

        // Warn if there's an error that wasn't the cancellation token.
        console.warn("Couldn't send callback during handshake", err)
      })
      .finally(() => {
        // Unsubscribe from the overarching cancellation token once this is dealt with
        this.cancellationToken.unsubscribe(cancellationToken.cancel)
      })
  }

  sendQuery = (messageID: string) => {
    dConnectionHandshakeOutgoing('Sent Query', messageID)

    const query = new Message(messageID, null)
    query.metadata.type = TYPES.CALLBACK
    query.metadata.internal = false
    query.metadata.query = true

    const cancellationToken = new CancellationToken(`Send Query for handshake: ${messageID}`)
    // Cancel this callback request if the overarching cancellation token triggers
    this.cancellationToken.subscribe(cancellationToken.cancel)

    return this.device
      .write(query, cancellationToken)
      .catch(err => {
        // istanbul ignore next
        if (cancellationToken.caused(err)) {
          return
        }

        // Warn if there's an error that wasn't the cancellation token.
        console.warn("Couldn't send query during handshake", err)
      })
      .finally(() => {
        // Unsubscribe from the overarching cancellation token once this is dealt with
        this.cancellationToken.unsubscribe(cancellationToken.cancel)
      })
  }

  onFinish = () => {
    measure(`binary-handshake:request-objects`)
    this.detachHandlers()

    dConnectionHandshake('Handshake succeeded!')

    this.complete()

    this.updateProgress(PROGRESS_KEYS.FINISHED)
  }

  onFail = () => {
    this.detachHandlers()
    dConnectionHandshake('Failed handshake...')
    this.updateProgress(PROGRESS_KEYS.FAILED)
    this.error(new Error('Maximum retries hit.'))
  }

  receiveHandler = (device: Device, message: Message, connection?: Connection) => {
    const internal = message.metadata.internal
    const messageID = message.messageID
    const payload = message.payload

    if (internal) {
      switch (messageID) {
        case this.fullState.listMessageID:
          measure(`binary-handshake:request-list`)
          this.dispatch({
            type: TRANSITIONS.RECEIVED_MESSAGEIDS,
            payload,
            messageID,
          })
          this.timeoutSince = this.getNow()

          return
        case this.fullState.amountMessageID:
          this.fullState.numberOfMessageIDs = payload

          this.updateProgress(PROGRESS_KEYS.RECEIVED_AMOUNT_OF_MESSAGEIDS, {
            total: payload,
          })

          this.dispatch({
            type: TRANSITIONS.RECEIVED_COUNT,
            payload,
            messageID,
          })
          this.timeoutSince = this.getNow()
          return
        default:
          return
      }
    }

    // it's a developer packet, sent during the correct time
    if (
      matchesState(this.currentState.value, 'request_objects_bulk.await_objects') ||
      matchesState(this.currentState.value, 'request_objects_individually.await_object')
    ) {
      // Do this in two steps
      this.dispatch({ type: TRANSITIONS.RECEIVED_OBJECT, messageID, payload })

      this.timeoutSince = this.getNow()
    } else {
      // received a developer packet outside of our request window
      dConnectionHandshake(`Received a developer packet outside of our request window`, message)
    }
  }

  defaultProgressText = (progressKey: PROGRESS_KEYS, meta: ProgressMeta): string | null => {
    switch (progressKey) {
      case PROGRESS_KEYS.FINISHED:
        return 'Finished'

      case PROGRESS_KEYS.RECEIVED_AMOUNT_OF_MESSAGEIDS:
        return 'Received list of MessageIDs, requesting data now.'

      case PROGRESS_KEYS.RECEIVED_MESSAGEIDS:
        return 'Received all data.'

      case PROGRESS_KEYS.RECEIVED_MESSAGEID:
        return `Received ${meta.messageID}`

      case PROGRESS_KEYS.REQUEST_LIST:
        return `Requesting list of MessageIDs${
          meta.retries !== undefined && meta.retries > 0 ? ` (retry #${meta.retries})` : ''
        }`

      case PROGRESS_KEYS.REQUEST_OBJECTS:
        return `Requesting bulk data${
          meta.retries !== undefined && meta.retries > 0 ? ` (retry #${meta.retries})` : ''
        }`
      case PROGRESS_KEYS.REQUEST_INDIVIDUAL:
        return `Requesting ${meta.messageID}${
          meta.retries !== undefined && meta.retries > 0 ? ` (retry #${meta.retries})` : ''
        }`

      case PROGRESS_KEYS.SWITCH_INDIVIDUAL_REQUEST_MODE:
        return `Received ${((meta.receivedCount! / meta.total!) * 100).toFixed(
          0,
        )}% of MessageIDs in bulk, switching to individual request mode`

      case PROGRESS_KEYS.FAILED:
        return null
    }
  }

  updateProgress = (progressKey: PROGRESS_KEYS, meta: ProgressMeta = {}) => {
    const now = this.getNow()
    const diff = now - this.lastProgress

    const progress = Array.from(this.fullState.messageIDObjects.values()).filter(val => val !== undefined).length
    const total = this.fullState.numberOfMessageIDs

    const text = this.getProgressText(progressKey, meta)

    // this.auditLog.mark(progressKey, true, meta)

    dConnectionHandshakeProgressUpdates(`Progress Update +${diff}ms: ${JSON.stringify({ progressKey, meta })}`)

    if (text !== null) {
      this.progress(new Progress(progress, total, text))
    }

    this.lastProgress = this.getNow()
  }

  attachHandlers = () => {
    mark(`binary-handshake`)
    dConnectionHandshake(`Attaching handlers`)
    this.device.on(DEVICE_EVENTS.RECEIVE_FROM_DEVICE, this.receiveHandler)
    this.interval = setInterval(this.loop, this.loopInterval)

    // If the cancellation token triggers, detach from the handlers
    this.cancellationToken.subscribe(this.detachHandlers)
  }

  detachHandlers = () => {
    measure(`binary-handshake`)
    dConnectionHandshake(`Detaching handlers`)
    this.device.removeListener(DEVICE_EVENTS.RECEIVE_FROM_DEVICE, this.receiveHandler)
    if (this.interval) {
      clearInterval(this.interval)
    }

    // If we detach, also detach from the cancellation token
    this.cancellationToken.unsubscribe(this.detachHandlers)
  }

  connect = () => {
    dConnectionHandshake(`Starting Handshake`)

    this.attachHandlers()

    // send initial request
    actionMap.requestList(
      this.fullState,
      {
        type: TRANSITIONS.START,
      },
      this.dispatch,
    )
  }

  loop = () => {
    const now = this.getNow()

    if (now - this.timeoutSince > this.timeout) {
      dConnectionHandshake(`Timed out during:`, this.currentState.value)
      this.dispatch({ type: TRANSITIONS.TIMEOUT, messageID: '' })
      this.timeoutSince = now
    }
  }

  getIdentifier() {
    return 'electricui-binary-protocol-handshake' as const
  }
}
