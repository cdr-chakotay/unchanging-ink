<template>
  <v-container>
    <v-row>
      <v-col cols="12" md="6">
        <v-card>
          <v-card-title class="headline">
            {{ t('createOrVerify') }}
          </v-card-title>
          <v-tabs v-model="selectedTab" color="primary" grow>
            <v-tab value="create">{{ t('createTimestamp') }}</v-tab>
            <v-tab value="verify">{{ t('verifyTimestamp') }}</v-tab>
          </v-tabs>
          <v-window v-model="selectedTab">
            <v-window-item value="create">
              <v-card-text @dragover="doverHandler" @drop="dropHandler">
                <v-textarea
                  v-model="createInput.text"
                  :disabled="!!createInput.files.length"
                  :placeholder="textPlaceholder"
                />
                <v-file-input
                  v-model="createInput.files"
                  :placeholder="filesPlaceholder"
                  chips
                  multiple
                  counter
                  :disabled="!!createInput.text.length"
                />
                <v-expansion-panels v-model="extendedOptionsOpen">
                  <v-expansion-panel>
                    <v-expansion-panel-title>
                      {{ t('extendedOptions') }}
                    </v-expansion-panel-title>
                    <v-expansion-panel-text>
                      <v-select
                        v-model="createInput.hash"
                        :items="hashItems"
                        :label="t('hashfunction')"
                        item-title="text"
                        item-value="value"
                      />
                    </v-expansion-panel-text>
                  </v-expansion-panel>
                </v-expansion-panels>
              </v-card-text>
              <v-expand-transition>
                <v-card-actions
                  v-show="createInput.text.length || createInput.files.length"
                >
                  <v-spacer></v-spacer>
                  <v-btn
                    size="large"
                    color="primary"
                    :disabled="
                      !createInput.text.length && !createInput.files.length
                    "
                    :loading="createLoading"
                    @click="doCreate"
                  >
                    <v-icon :icon="mdiStamper"></v-icon>
                    {{ t('createTimestamp') }}
                    <!--                    Fixme: Should do it dynamically based on progressToNext-->
                    <template #loader>
                      <v-progress-linear
                        color="primary"
                        height="10"
                        rounded
                        class="mx-2 flex-grow-1"
                        :indeterminate="
                          createPending || progressToNext === null
                        "
                        :model-value="
                          createPending || progressToNext === null
                            ? undefined
                            : progressToNext
                        "
                      />
                    </template>
                  </v-btn>
                </v-card-actions>
              </v-expand-transition>
            </v-window-item>
            <v-window-item value="verify">
              <v-card-text @dragover="doverHandler" @drop="dropHandler">
                <v-textarea
                  v-model="verifyInput.text"
                  :disabled="!!verifyInput.files.length"
                  :placeholder="textPlaceholder"
                />
                <v-file-input
                  v-model="verifyInput.files"
                  :placeholder="filesPlaceholder"
                  chips
                  multiple
                  counter
                  :disabled="!!verifyInput.text.length"
                />
                <v-textarea
                  v-model="verifyInput.ts"
                  placeholder="Timestamp / Proof JSON"
                />
              </v-card-text>
              <v-expansion-panels v-model="extendedOptionsOpen">
                <v-expansion-panel>
                  <v-expansion-panel-title>
                    {{ t('extendedOptions') }}
                  </v-expansion-panel-title>
                  <v-expansion-panel-text>
                    <v-select
                      v-model="verifyInput.hash"
                      :items="hashItems"
                      :label="t('hashfunction')"
                      item-title="text"
                      item-value="value"
                    />
                  </v-expansion-panel-text>
                </v-expansion-panel>
              </v-expansion-panels>
              <v-expand-transition>
                <v-card-actions
                  v-show="verifyInput.text.length || verifyInput.files.length"
                >
                  <v-spacer></v-spacer>
                  <v-btn
                    size="large"
                    color="primary"
                    :disabled="
                      (!verifyInput.text.length && !verifyInput.files.length) ||
                      !verifyInput.ts.length
                    "
                    @click="doVerify"
                  >
                    <v-icon :icon="mdiStamper"></v-icon>
                    {{ t('verifyTimestamp') }}
                  </v-btn>
                </v-card-actions>
              </v-expand-transition>
            </v-window-item>
          </v-window>
        </v-card>
      </v-col>
      <v-col cols="12" md="6">
        <timeline-card
          ref="timeline"
          :items="tickItems"
          :progress-to-next="progressToNext"
        />
      </v-col>
    </v-row>
    <v-row>
      <v-col v-if="createdTimestamps.length" cols="12" md="6">
        <v-card>
          <v-card-title class="headline">
            {{ t('createdTimestamps') }}
          </v-card-title>
          <v-card-text v-for="ts in createdTimestamps" :key="ts.id">
            <pre>{{ JSON.stringify(ts, null, 2) }}</pre>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
    <v-snackbar
      v-model="verifySnackbar.show"
      :color="verifySnackbar.color"
      :timeout="5000"
    >
      {{ verifySnackbar.message }}
      <template #action="{ attrs }">
        <v-btn
          variant="text"
          v-bind="attrs"
          @click="verifySnackbar.show = false"
        >
          {{ t('close') }}
        </v-btn>
      </template>
    </v-snackbar>
  </v-container>
</template>
<script setup>
import { mdiStamper } from '@mdi/js'
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
} from 'vue'
import { useI18n } from 'vue-i18n'
import TimelineCard from '../components/Timeline'
import { computeHash } from '../utils/hashing'
import { sleep } from '../utils/misc'
import {
  base64UrlDecode,
  parseCompactTs,
  TimestampService,
  verifyConsistencyProof,
} from '../utils/uits'
import { validateTsInput } from '~/utils/validate'

const { t } = useI18n()
const runtimeConfig = useRuntimeConfig()

const UiTs = shallowRef(null)
const now = ref(new Date())
const nowInterval = ref(null)
const selectedTab = ref('create')
const extendedOptionsOpen = ref(false)
const createLoading = ref(false)
const createPending = ref(false)
const createdTimestamps = ref([])
const tickListener = ref(null)
const tickItems = ref([])
const createInput = reactive({
  text: '',
  files: [],
  hash: 'sha512',
})
const verifyInput = reactive({
  text: '',
  files: [],
  ts: '',
  hash: 'sha512',
})
const verifySnackbar = reactive({
  show: false,
  message: '',
  color: 'success',
})

const { data: initialTicks } = await useAsyncData('recent-mth', async () => {
  if (!process.server) {
    return []
  }
  const { promisify } = await import('util')
  const redis = await import('redis')
  const serverService = new TimestampService(runtimeConfig.public.authority)
  const client = redis.createClient('redis://redis/0')
  const getAsync = promisify(client.get).bind(client)
  const val = await getAsync('recent-mth')
  client.quit?.()
  const recent = JSON.parse(val || '[]') ?? []
  recent.forEach((item) => serverService.tick(item, true))
  return JSON.parse(JSON.stringify(serverService.tickItems))
})

if (initialTicks.value?.length) {
  tickItems.value = initialTicks.value
}

useHead(() => ({
  title: t('homepage'),
}))

const hashItems = computed(() => [
  { text: 'SHA-512', value: 'sha512' },
  { text: t('rawHash'), value: 'raw' },
])

const textPlaceholder = computed(() => {
  if (!createInput.files.length) {
    return t('dropTextOrDragFile')
  }
  return t('optionAddMoreFiles')
})

const filesPlaceholder = computed(() => {
  if (!createInput.text.length) {
    return t('alternateSelectFile')
  }
  return ''
})

const progressToNext = computed(() => {
  if (
    !UiTs.value?.estimatedNextTick ||
    !UiTs.value?.averageTickDurationMillis
  ) {
    return null
  }
  let diff =
    (UiTs.value.estimatedNextTick - now.value) /
    UiTs.value.averageTickDurationMillis
  if (diff < 0) {
    diff = 0
  }
  if (diff > 1.0) {
    diff = 1.0
  }
  diff = (1.0 - diff) * 100
  diff = (100.0 / 80.0) * diff - (20 * 100) / 80
  if (diff < 0) {
    diff = 0
  }
  return diff
})

onMounted(() => {
  UiTs.value = new TimestampService(window.location.origin)
  if (tickItems.value?.length) {
    UiTs.value.tickItems = [...tickItems.value]
  }
  tickListener.value = UiTs.value.addListener((item) => {
    tickItems.value.unshift(item)
    tickItems.value = tickItems.value.slice(0, 5)
  })
  UiTs.value.openLiveConnection()
  nowInterval.value = window.setInterval(() => {
    now.value = new Date()
  }, 100)
})

onBeforeUnmount(() => {
  if (nowInterval.value !== null) {
    window.clearInterval(nowInterval.value)
    nowInterval.value = null
  }
  UiTs.value?.closeLiveConnection()
  if (tickListener.value !== null) {
    UiTs.value?.removeListener(tickListener.value)
    tickListener.value = null
  }
  UiTs.value = null
})

async function doCreate() {
  try {
    createLoading.value = true
    createPending.value = true

    const data_hash = await computeHash(createInput)
    const ts = await UiTs.value.getTimestamp(data_hash, {
      firstStepCallback: async () => {
        createPending.value = false
      },
    })
    await sleep(1000)
    createdTimestamps.value.unshift(ts)
  } finally {
    createLoading.value = false
    createPending.value = false
  }
}

async function doVerify() {
  let failReason = null
  const warnings = []
  let error = null
  try {
    const data_hash = await computeHash(verifyInput)
    const ts = await validateTsInput(JSON.parse(verifyInput.ts))

    // Step 1: verify data inclusion in interval tree
    const verified_ith = await UiTs.value.verifyTimestamp(data_hash, ts)
    if (!verified_ith) {
      failReason = 'verifyFailIthNotIncluded'
      return
    }

    // Step 2: verify integration of interval tree into main tree
    // NOTE: verifyIntervalInclusion uses ts.proof.interval_ts (the interval seal time),
    // not ts.timestamp (the entry submission time) — these differ and using ts.timestamp would always fail.
    const localMth = base64UrlDecode(ts.proof.mth.match(/[^:]+$/)[0])
    const proof_mth = localMth.toString('base64')
    const cached_mth = await UiTs.value.getCachedMthForInterval(
      ts.interval,
      false,
    )
    const mthComponents = parseCompactTs(ts.proof.mth)
    const headInterval = parseInt(mthComponents.interval)

    if (cached_mth && cached_mth !== proof_mth) {
      failReason = 'verifyFailIthNotInMth'
      return
    }
    if (!cached_mth) {
      warnings.push('verifyWarnMthNotCached')
    }

    const inclusion_proof = await UiTs.value.getInclusionProof(
      ts.interval,
      headInterval,
    )
    const verified_mth = await UiTs.value.verifyIntervalInclusion(
      ts,
      inclusion_proof,
    )
    if (!verified_mth) {
      failReason = 'verifyFailIthNotInMth'
      return
    }

    // Step 3: verify consistency of local MTH with remote (current) MTH
    let remoteMth = null
    const INTERVAL_WAIT_MS = 4000
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(INTERVAL_WAIT_MS)
      try {
        remoteMth = await UiTs.value.fetchLatestMth()
        if (remoteMth.interval > headInterval) break
      } catch (e) {
        remoteMth = null
      }
    }

    if (!remoteMth) {
      failReason = 'verifyFailConsistencyFetchFailed'
      return
    }
    if (remoteMth.interval <= headInterval) {
      failReason = 'verifyFailMthNotNewer'
      return
    }

    const consistencyProof = await UiTs.value.getConsistencyProof(
      headInterval + 1,
      remoteMth.interval,
    )
    const consistent = verifyConsistencyProof({
      oldWidth: headInterval + 1,
      oldRoot: localMth,
      newWidth: remoteMth.interval + 1,
      newRoot: remoteMth.mth,
      proofNodes: consistencyProof.nodes.map((n) => Buffer.from(n, 'base64')),
    })
    if (!consistent) {
      failReason = 'verifyFailMthNotConsistent'
      return
    }
  } catch (err) {
    error = err
  } finally {
    verifySnackbar.show = true
    if (error) {
      verifySnackbar.message = t('verifyError', { error: error.message })
      verifySnackbar.color = 'warning'
    } else if (failReason) {
      verifySnackbar.message = t(failReason)
      verifySnackbar.color = 'error'
    } else {
      let message = t('verifySuccess')
      if (warnings.length) {
        message += ' ' + warnings.map((w) => t(w)).join(' ')
      }
      verifySnackbar.message = message
      verifySnackbar.color = 'success'
    }
  }
}

function doverHandler(event) {
  event.preventDefault()
}

function dropHandler(event) {
  event.preventDefault()

  if (event.dataTransfer.items) {
    for (let i = 0; i < event.dataTransfer.items.length; i++) {
      if (event.dataTransfer.items[i].kind === 'file') {
        const file = event.dataTransfer.items[i].getAsFile()
        createInput.files.push(file)
      }
    }
  } else {
    for (let i = 0; i < event.dataTransfer.files.length; i++) {
      createInput.files.push(event.dataTransfer.files[i])
    }
  }
}
</script>
<i18n lang="yaml">
de:
  createTimestamp: Zeitstempel erzeugen
  verifyTimestamp: Zeitstempel überprüfen
  createOrVerify: Erzeugen oder Überprüfen
  homepage: Startseite
  dropTextOrDragFile: Hier Text eintragen oder Datei ziehen
  optionAddMoreFiles: 'Optional: Mehr Dateien hinzufügen'
  alternateSelectFile: 'Alternativ: Datei wählen'
  hashfunction: Hash-Funktion
  extendedOptions: Erweiterte Einstellungen
  rawHash: Rohdaten/ungehasht (max 256 Bytes)
  createdTimestamps: Zuletzt erzeugte Zeitstempel
  verifyError: 'Fehler bei der Überprüfung: {error}'
  verifySuccess: Zeitstempel ist für die bereitgestellten Daten gültig.
  verifyFailed: Zeitstempel ist NICHT gültig für die bereitgestellten Daten.
  verifyFailIthNotIncluded: Daten sind nicht im Intervallbaum enthalten.
  verifyFailIthNotInMth: Intervallbaum ist nicht im Hauptbaum enthalten.
  verifyFailMthNotConsistent: Hauptbaum ist nicht konsistent mit dem aktuellen Hauptbaum der Autorität.
  verifyFailConsistencyFetchFailed: Aktueller Hauptbaum der Autorität konnte nicht abgerufen werden.
  verifyFailMthNotNewer: Autorität hat keinen neueren Hauptbaum als den bereits bekannten.
  verifyWarnMthNotCached: MTH war nicht lokal zwischengespeichert.
  close: Schließen
en:
  createTimestamp: Create timestamp
  verifyTimestamp: Verify timestamp
  createOrVerify: Create or Verify
  homepage: Home Page
  dropTextOrDragFile: Enter text or drag and drop file here
  optionAddMoreFiles: 'Optional: Add more files'
  alternateSelectFile: 'Alternatively: Select file'
  hashfunction: Hash function
  extendedOptions: Extended Options
  rawHash: raw/no hash (max 256 bytes)
  createdTimestamps: Created timestamps
  verifyError: 'Error during verification: {error}'
  verifySuccess: Timestamp is valid for the provided data.
  verifyFailed: Timestamp is NOT valid for the provided data.
  verifyFailIthNotIncluded: Data is not included in the interval tree.
  verifyFailIthNotInMth: Interval tree is not part of the main tree.
  verifyFailMthNotConsistent: Main tree is not verifiable against the remote main tree.
  verifyFailConsistencyFetchFailed: Could not fetch current main tree from authority.
  verifyFailMthNotNewer: Authority does not have a newer main tree than the one already known.
  verifyWarnMthNotCached: MTH was not locally cached.
  close: Close
</i18n>
