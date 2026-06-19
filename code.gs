/**
 * ============================================================================
 * SORARE MULTI-GALLERY SYNC - STRUCTURED EDITION V10
 * ============================================================================
 *
 * OBIETTIVO
 * - Light sync separato da floor refresh.
 * - Query light alleggerita per evitare errori di complexity.
 * - Trigger automatici con AVVIA_TUTTO().
 * - Continuazione automatica per timeout Apps Script.
 * - Retry robusti per errori HTTP 429/502/503/504 e problemi rete.
 * - Aggiornamento ExchangeRates a ogni esecuzione.
 * - Aggiornamento colonna "Ultimo Aggiornamento" durante floor refresh.
 * - Riduzione consumo UrlFetch con cache persistente floor e trigger ricalibrati.
 *
 * REQUISITI
 * - Attivare il servizio avanzato Google Sheets.
 * - Verificare che i fogli esistano: Foglio1, ExchangeRates.
 *
 * QUERY SORARE USATE (verificate sullo schema attuale)
 * - user(slug) { cards(after, first, rarities) { nodes { slug ownerSince rarityTyped
 *   inSeasonEligible grade xp xpNeededForCurrentGrade xpNeededForNextGrade seasonYear
 *   serialNumber secondaryMarketFeeEnabled pictureUrl anyPositions liveSingleSaleOffer
 *   anyPlayer { slug displayName } } pageInfo } }
 * - anyPlayer(slug) { lowestPriceAnyCard(rarity, inSeason) { ... } }
 * ============================================================================
 */

var RUNTIME_STATS = { urlFetchCalls: 0, discordCalls: 0 };

const CONFIG = Object.freeze({
  app: {
    timezoneFormat: 'yyyy-MM-dd HH:mm:ss'
  },

  sorare: {
    apiUrl: 'https://api.sorare.com/graphql',
    apiVersion: 'v1',
    apiKey: 'be8913e8f7ebd4225a5a48cee860dc8997d2dd88b1c4260beef68bc60c6484981e4357f0f274b3013ad5228e5b82cf36ab293411a39a9b5c9305f61da71sr128',  
    allowedRarities: ['limited', 'rare', 'super_rare', 'unique'],
    pageSize: 50,
    dailySafetyCap: 18000,
    floorCacheHours: 6,
    maxHttpAttempts: 4
  },

  sheets: {
    mainSheetName: 'Foglio1',
    exchangeSheetName: 'ExchangeRates',
    maxReadCols: 80,
    writeChunkSize: 200,
    appendChunkSize: 200,
    maxWriteAttempts: 6
  },

  execution: {
    softLimitMs: 280000,
    continueDelayMs: 60 * 1000,
    allowedStartHour: 8,
    allowedEndHourExclusive: 24
  },

  pacing: {
    betweenSorareCallsMs: 250,
    betweenWriteChunksMs: 500,
    betweenDeleteBurstsMs: 250
  },

  stateKeys: {
    light: 'SORARE_LIGHTSYNC_STATE_V10',
    floor: 'SORARE_FLOORSYNC_STATE_V10',
    dailyUrlFetchCount: 'SORARE_DAILY_URLFETCH_COUNT_V1',
    dailyUrlFetchDate: 'SORARE_DAILY_URLFETCH_DATE_V1',
    floorCachePrefix: 'SORARE_FLOOR_CACHE_V1_'
  }
});

const GALLERIES = Object.freeze([
  {
    key: 'solosamp88',
    userSlug: 'solosamp88',
    spreadsheetId: '1oYxXK5gyiNqo_V1CkQvbkBu0hdD60E7xxw7X5GxIPPo',
    discordWebhook: 'INCOLLA_WEBHOOK_1'
  },
  {
    key: 'spisti93',
    userSlug: 'spisti93',
    spreadsheetId: '1K7B57sp_vTpntFTYOe_yfOg3Pr4QKFq5mpqIQxX_kis',
    discordWebhook: 'INCOLLA_WEBHOOK_2'
  },
  {
    key: 'sticazzi',
    userSlug: 'sticazzi',
    spreadsheetId: '1LRYZ7Rn4WmMzsM15sjO0lz_F9rsZi-mTnK9vrPffIRQ',
    discordWebhook: 'INCOLLA_WEBHOOK_3'
  },
  {
    key: 'betterthanthem-plusvalencia',
    userSlug: 'betterthanthem-plusvalencia',
    spreadsheetId: '1PTNR8xoBGzTCWCXCrr9rOnNgGcIrgFpCsaDwwvEYa3w',
    discordWebhook: 'INCOLLA_WEBHOOK_4'
  }
]);

const HEADER_ALIASES = Object.freeze({
  slug: ['Slug'],
  rarity: ['Rarity'],
  playerName: ['Player Name'],
  playerSlug: ['Player API Slug'],
  inSeason: ['In Season?'],
  updatedAt: ['Ultimo Aggiornamento'],
  ownerSince: ['Owner Since'],
  salePrice: ['Sale Price EUR', 'Sale Price (EUR)', 'Sale Price €'],
  position: ['Position', 'Posizione'],
  level: ['Livello', 'Level'],
  xpCurrent: ['XP Corrente', 'XP Current'],
  xpCurrentGradeStart: ['XP Inizio Livello', 'XP Needed For Current Grade'],
  xpNext: ['XP Prox Livello', 'XP Next Level'],
  xpMissing: ['XP Mancanti Livello', 'XP Missing Level'],
  seasonYear: ['Season Year', 'Anno Stagione'],
  serialNumber: ['Serial Number', 'Serial', 'Numero Seriale'],
  feeEnabled: ['Fee Abilitata?', 'Fee Enabled?'],
  photoUrl: ['Foto URL', 'Picture URL'],
  l5: ['L5 So5', 'L5'],
  l15: ['L15 So5', 'L15'],
  projectedClassic: ['Projected Score', 'Projected Score Classic'],
  projectedDaily: ['Projected Score Daily'],
  nextGame: ['Partita', 'Next Game'],
  nextGameDate: ['Data Prossima Partita', 'Next Game Date'],
  floorLimitedClassic: ['FLOOR CLASSIC LIMITED'],
  floorRareClassic: ['FLOOR CLASSIC RARE'],
  floorSrClassic: ['FLOOR CLASSIC SR'],
  floorUniqueClassic: ['FLOOR CLASSIC UNIQUE'],
  floorLimitedSeason: ['FLOOR IN SEASON LIMITED'],
  floorRareSeason: ['FLOOR IN SEASON RARE'],
  floorSrSeason: ['FLOOR IN SEASON SR'],
  floorUniqueSeason: ['FLOOR IN SEASON UNIQUE']
});

const QUERIES = Object.freeze({
  galleryCards: `
    query GalleryCards($userSlug: String!, $after: String, $rarities: [Rarity!]) {
      user(slug: $userSlug) {
        slug
        cards(after: $after, first: 50, rarities: $rarities) {
          nodes {
            slug
            ownerSince
            rarityTyped
            inSeasonEligible
            grade
            xp
            xpNeededForCurrentGrade
            xpNeededForNextGrade
            seasonYear
            serialNumber
            secondaryMarketFeeEnabled
            pictureUrl
            anyPositions
            liveSingleSaleOffer {
              receiverSide {
                amounts {
                  eurCents
                  referenceCurrency
                }
              }
            }
            anyPlayer {
              slug
              displayName
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `,

  playerFloor: `
    query PlayerFloor($slug: String!, $rarity: Rarity, $inSeason: Boolean) {
      anyPlayer(slug: $slug) {
        slug
        lowestPriceAnyCard(rarity: $rarity, inSeason: $inSeason) {
          slug
          rarityTyped
          inSeasonEligible
          liveSingleSaleOffer {
            receiverSide {
              amounts {
                eurCents
                referenceCurrency
              }
            }
          }
        }
      }
    }
  `
});

function AVVIA_TUTTO() {
  deleteAllProjectTriggers_();
  clearState_(CONFIG.stateKeys.light);
  clearState_(CONFIG.stateKeys.floor);

  ScriptApp.newTrigger('scheduledRunLightSyncAll').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('scheduledRunFloorRefreshAll').timeBased().everyHours(2).create();

  log_('SYSTEM', 'TRIGGERS', 'Creati trigger: light ogni 15 minuti, floor ogni 3 ore');
}

function scheduledRunLightSyncAll() {
  if (!isWithinExecutionWindow_()) {
    log_('LIGHT', 'WINDOW', 'Fuori fascia oraria consentita, skip esecuzione schedulata');
    return;
  }
  runLightSyncAll();
}

function runLightSyncAll() {
  resetRuntimeStats_();
  deleteTriggersByName_('continueRunLightSyncAll');

  const state = loadState_(CONFIG.stateKeys.light) || { galleryIndex: 0 };
  const startMs = Date.now();

  log_('LIGHT', 'START', 'Ripresa da galleryIndex=' + state.galleryIndex);

  for (let i = state.galleryIndex; i < GALLERIES.length; i++) {
    const gallery = GALLERIES[i];
    log_('LIGHT', gallery.key, 'Inizio galleria ' + (i + 1) + '/' + GALLERIES.length);

    try {
      refreshExchangeRatesForGallery_(gallery);
      runLightSyncForGallery_(gallery, startMs);
      log_('LIGHT', gallery.key, 'Completata');
    } catch (e) {
      log_('LIGHT', gallery.key, 'ERRORE: ' + errorMessage_(e));
      notifyDiscord_(gallery, '❌ Light sync errore su ' + gallery.key + ': ' + errorMessage_(e));
    }

    if (isNearTimeout_(startMs)) {
      saveState_(CONFIG.stateKeys.light, { galleryIndex: i + 1 });
      scheduleContinuation_('continueRunLightSyncAll');
      log_('LIGHT', 'PAUSE', 'Timeout vicino, continuerò da galleryIndex=' + (i + 1));
      return;
    }
  }

  clearState_(CONFIG.stateKeys.light);
  logRuntimeStats_('LIGHT');
  log_('LIGHT', 'DONE', 'Light sync terminato su tutte le gallerie');
}

function continueRunLightSyncAll() {
  if (!isWithinExecutionWindow_()) {
    log_('LIGHT', 'WINDOW', 'Fuori fascia oraria consentita, skip continuazione');
    return;
  }
  runLightSyncAll();
}

function scheduledRunFloorRefreshAll() {
  if (!isWithinExecutionWindow_()) {
    log_('FLOOR', 'WINDOW', 'Fuori fascia oraria consentita, skip esecuzione schedulata');
    return;
  }
  runFloorRefreshAll();
}

function runFloorRefreshAll() {
  resetRuntimeStats_();
  deleteTriggersByName_('continueRunFloorRefreshAll');

  const startMs = Date.now();
  let state = loadState_(CONFIG.stateKeys.floor);

  if (!state) {
    const requests = collectUniqueFloorRequestsAcrossGalleries_();
    state = {
      phase: 'fetch',
      fetchIndex: 0,
      applyGalleryIndex: 0,
      requests: requests,
      floorMap: {}
    };
    saveState_(CONFIG.stateKeys.floor, state);
    log_('FLOOR', 'BUILD', 'Combinazioni uniche trovate=' + requests.length);
  }

  if (state.phase === 'fetch') {
    const fetchResult = continueFloorFetchPhase_(state, startMs);
    state = fetchResult.state;
    saveState_(CONFIG.stateKeys.floor, state);

    if (!fetchResult.done) {
      scheduleContinuation_('continueRunFloorRefreshAll');
      log_('FLOOR', 'PAUSE', 'Fetch floor messo in pausa a indice=' + state.fetchIndex);
      return;
    }

    state.phase = 'apply';
    state.applyGalleryIndex = 0;
    saveState_(CONFIG.stateKeys.floor, state);
    log_('FLOOR', 'FETCH', 'Fetch completato, passo ad apply');
  }

  if (state.phase === 'apply') {
    for (let i = state.applyGalleryIndex; i < GALLERIES.length; i++) {
      const gallery = GALLERIES[i];
      log_('FLOOR', gallery.key, 'Apply galleria ' + (i + 1) + '/' + GALLERIES.length);

      try {
        refreshExchangeRatesForGallery_(gallery);
        applyFloorUpdatesToGallery_(gallery, state.floorMap, startMs);
      } catch (e) {
        log_('FLOOR', gallery.key, 'ERRORE: ' + errorMessage_(e));
        notifyDiscord_(gallery, '❌ Floor refresh errore su ' + gallery.key + ': ' + errorMessage_(e));
      }

      state.applyGalleryIndex = i + 1;
      saveState_(CONFIG.stateKeys.floor, state);

      if (isNearTimeout_(startMs)) {
        scheduleContinuation_('continueRunFloorRefreshAll');
        log_('FLOOR', 'PAUSE', 'Apply in pausa, continuerò da galleryIndex=' + state.applyGalleryIndex);
        return;
      }
    }
  }

  clearState_(CONFIG.stateKeys.floor);
  logRuntimeStats_('FLOOR');
  log_('FLOOR', 'DONE', 'Floor refresh terminato su tutte le gallerie');
}

function continueRunFloorRefreshAll() {
  if (!isWithinExecutionWindow_()) {
    log_('FLOOR', 'WINDOW', 'Fuori fascia oraria consentita, skip continuazione');
    return;
  }
  runFloorRefreshAll();
}

function resetStatesAndTriggers() {
  clearState_(CONFIG.stateKeys.light);
  clearState_(CONFIG.stateKeys.floor);
  deleteTriggersByName_('runLightSyncAll');
  deleteTriggersByName_('runFloorRefreshAll');
  deleteTriggersByName_('scheduledRunLightSyncAll');
  deleteTriggersByName_('scheduledRunFloorRefreshAll');
  deleteTriggersByName_('continueRunLightSyncAll');
  deleteTriggersByName_('continueRunFloorRefreshAll');
  log_('SYSTEM', 'RESET', 'Puliti stati e trigger');
}

function AGGIORNA_CAMBI_SOLO() {
  GALLERIES.forEach(function(gallery) {
    try {
      refreshExchangeRatesForGallery_(gallery);
    } catch (e) {
      log_('FX', gallery.key, 'ERRORE: ' + errorMessage_(e));
    }
  });
}

function runLightSyncForGallery_(gallery, startMs) {
  const remoteCards = fetchGalleryCards_(gallery.userSlug, startMs);
  log_('LIGHT', gallery.key, 'Carte API recuperate=' + remoteCards.length);

  const spreadsheet = SpreadsheetApp.openById(gallery.spreadsheetId);
  const sheet = spreadsheet.getSheetByName(CONFIG.sheets.mainSheetName);
  if (!sheet) throw new Error('Foglio non trovato: ' + CONFIG.sheets.mainSheetName);

  const initialData = readSheetSafely_(sheet);
  const headers = initialData.headers;
  const rows = initialData.rows;
  const idx = buildHeaderIndexMap_(headers);
  validateMainSheetHeaders_(idx);

  const existingBySlug = mapExistingRowsBySlug_(rows, idx.slug);
  const remoteBySlug = mapRemoteCardsBySlug_(remoteCards);

  const rowsToDelete = findRowsToDelete_(existingBySlug, remoteBySlug);
  deleteRowsDescending_(sheet, rowsToDelete, gallery.key);

  const refreshedData = readSheetSafely_(sheet);
  const refreshedHeaders = refreshedData.headers;
  const refreshedRows = refreshedData.rows;
  const refreshedIdx = buildHeaderIndexMap_(refreshedHeaders);
  const refreshedBySlug = mapExistingRowsBySlug_(refreshedRows, refreshedIdx.slug);

  const buildResult = buildLightSyncWriteSets_(remoteCards, refreshedHeaders, refreshedBySlug);

  log_('LIGHT', gallery.key,
    'Update=' + buildResult.updates.length +
    ' | Append=' + buildResult.appends.length +
    ' | Unchanged skip=' + buildResult.unchangedSkipped +
    ' | Delete=' + rowsToDelete.length
  );

  batchUpdateValues_(spreadsheet.getId(), buildResult.updates, 'LIGHT/' + gallery.key, startMs);
  appendRowsChunked_(sheet, buildResult.appends, refreshedHeaders.length, 'LIGHT/' + gallery.key, startMs);
}

function buildLightSyncWriteSets_(remoteCards, headers, existingBySlug) {
  const updates = [];
  const appends = [];
  let unchangedSkipped = 0;

  remoteCards.forEach(function(card) {
    const slug = normalizeText_(card.slug);
    const newRow = buildManagedMainRow_(headers, card);
    const existing = existingBySlug[slug];

    if (!existing) {
      appends.push(newRow);
      return;
    }

    const mergedRow = mergeManagedColumnsOnly_(existing.row.slice(), newRow, headers);
    if (rowsAreEqual_(existing.row, mergedRow)) {
      unchangedSkipped++;
      return;
    }

    updates.push({
      range: CONFIG.sheets.mainSheetName + '!A' + existing.rowIndex,
      values: [mergedRow]
    });
  });

  return {
    updates: updates,
    appends: appends,
    unchangedSkipped: unchangedSkipped
  };
}

function collectUniqueFloorRequestsAcrossGalleries_() {
  const uniqueMap = {};

  GALLERIES.forEach(function(gallery) {
    const spreadsheet = SpreadsheetApp.openById(gallery.spreadsheetId);
    const sheet = spreadsheet.getSheetByName(CONFIG.sheets.mainSheetName);
    if (!sheet) return;

    const data = readSheetSafely_(sheet);
    if (!data.headers.length || !data.rows.length) {
      log_('FLOOR', gallery.key, 'Foglio vuoto o senza righe utili');
      return;
    }

    const idx = buildHeaderIndexMap_(data.headers);
    validateFloorSheetHeaders_(idx);

    let validRows = 0;

    data.rows.forEach(function(row) {
      const playerSlug = normalizeText_(row[idx.playerSlug]);
      const rarity = normalizeRarityForApi_(row[idx.rarity]);
      const inSeason = normalizeSeasonFlag_(row[idx.inSeason]);
      if (!playerSlug || !rarity) return;

      const key = floorRequestKey_(playerSlug, rarity, inSeason);
      if (!uniqueMap[key]) {
        uniqueMap[key] = {
          playerSlug: playerSlug,
          rarity: rarity,
          inSeason: inSeason
        };
      }
      validRows++;
    });

    log_('FLOOR', gallery.key, 'Righe considerate per floor=' + validRows);
  });

  return Object.keys(uniqueMap).map(function(key) {
    return uniqueMap[key];
  });
}

function continueFloorFetchPhase_(state, startMs) {
  const requests = state.requests || [];
  const floorMap = state.floorMap || {};

  for (let i = state.fetchIndex; i < requests.length; i++) {
    const request = requests[i];
    const key = floorRequestKey_(request.playerSlug, request.rarity, request.inSeason);

    if (typeof floorMap[key] !== 'undefined') {
      state.fetchIndex = i + 1;
      continue;
    }

    const cached = getCachedFloor_(request.playerSlug, request.rarity, request.inSeason);
    if (cached.found) {
      floorMap[key] = cached.value;
      state.floorMap = floorMap;
      state.fetchIndex = i + 1;
      continue;
    }

    log_('FLOOR', 'FETCH',
      'Richiesta ' + (i + 1) + '/' + requests.length +
      ' -> ' + request.playerSlug +
      ' | ' + request.rarity +
      ' | ' + (request.inSeason ? 'inSeason' : 'classic')
    );

    try {
      const floor = fetchPlayerFloor_(request.playerSlug, request.rarity, request.inSeason);
      floorMap[key] = floor;
      state.floorMap = floorMap;
      state.fetchIndex = i + 1;
      setCachedFloor_(request.playerSlug, request.rarity, request.inSeason, floor);
    } catch (e) {
      const msg = errorMessage_(e);
      log_('FLOOR', 'FETCH', 'Errore floor su ' + key + ' -> ' + msg);

      if (isRetryableNetworkError_(msg)) {
        log_('FLOOR', 'FETCH', 'Errore retryable persistente, metto in pausa la continuazione');
        return { done: false, state: state };
      }

      throw e;
    }

    Utilities.sleep(CONFIG.pacing.betweenSorareCallsMs);

    if (isNearTimeout_(startMs)) {
      return { done: false, state: state };
    }
  }

  return { done: true, state: state };
}

function applyFloorUpdatesToGallery_(gallery, floorMap, startMs) {
  const spreadsheet = SpreadsheetApp.openById(gallery.spreadsheetId);
  const sheet = spreadsheet.getSheetByName(CONFIG.sheets.mainSheetName);
  if (!sheet) throw new Error('Foglio non trovato: ' + CONFIG.sheets.mainSheetName);

  const data = readSheetSafely_(sheet);
  if (!data.headers.length || !data.rows.length) {
    log_('FLOOR', gallery.key, 'Nessuna riga da aggiornare');
    return;
  }

  const headers = data.headers;
  const rows = data.rows;
  const idx = buildHeaderIndexMap_(headers);
  validateFloorSheetHeaders_(idx);

  const updates = [];
  let matched = 0;
  let unchanged = 0;

  rows.forEach(function(row, rowIdx) {
    const playerSlug = normalizeText_(row[idx.playerSlug]);
    const rarity = normalizeRarityForApi_(row[idx.rarity]);
    const inSeason = normalizeSeasonFlag_(row[idx.inSeason]);
    if (!playerSlug || !rarity) return;

    const key = floorRequestKey_(playerSlug, rarity, inSeason);
    const floor = floorMap[key];
    if (floor === '' || floor === null || typeof floor === 'undefined') return;

    const floorColIndex = getFloorColumnIndex_(headers, rarity, inSeason);
    if (floorColIndex < 0) return;

    const currentFloorValue = row[floorColIndex];
    if (String(currentFloorValue || '') === String(floor || '')) {
      unchanged++;
      return;
    }

    const newRow = buildRowWithFloorAndTimestamp_(row, floorColIndex, floor, idx.updatedAt);
    updates.push({
      range: CONFIG.sheets.mainSheetName + '!A' + (rowIdx + 2),
      values: [newRow]
    });
    matched++;
  });

  log_('FLOOR', gallery.key,
    'Update floor=' + updates.length +
    ' | Match=' + matched +
    ' | Unchanged=' + unchanged
  );

  batchUpdateValues_(spreadsheet.getId(), updates, 'FLOOR/' + gallery.key, startMs);
}

function refreshExchangeRatesForGallery_(gallery) {
  const spreadsheet = SpreadsheetApp.openById(gallery.spreadsheetId);
  const sheet = spreadsheet.getSheetByName(CONFIG.sheets.exchangeSheetName);

  if (!sheet) {
    log_('FX', gallery.key, 'Foglio ExchangeRates non trovato, skip');
    return;
  }

  log_('FX', gallery.key, 'Aggiornamento ExchangeRates con formule GoogleFinance');

  sheet.getRange('A1:E1').setValues([[
    'USD to EUR',
    'GBP to EUR',
    'ETH to EUR',
    'SOL to EUR',
    'LAMPORT to EUR'
  ]]);

  sheet.getRange('A2').setFormula('=GOOGLEFINANCE("CURRENCY:USDEUR")');
  sheet.getRange('B2').setFormula('=GOOGLEFINANCE("CURRENCY:GBPEUR")');
  sheet.getRange('C2').setFormula('=GOOGLEFINANCE("CURRENCY:ETHEUR")');
  sheet.getRange('D2').setFormula('=GOOGLEFINANCE("CURRENCY:SOLEUR")');
  sheet.getRange('E2').setFormula('=D2/1000000000');
}

function fetchGalleryCards_(userSlug, startMs) {
  let after = null;
  let hasNextPage = true;
  let page = 0;
  const allCards = [];

  while (hasNextPage) {
    page++;
    log_('API', userSlug, 'Fetch pagina carte #' + page);

    const response = sorareGraphqlFetch_(QUERIES.galleryCards, {
      userSlug: userSlug,
      after: after,
      rarities: CONFIG.sorare.allowedRarities
    });

    const connection = response && response.data && response.data.user && response.data.user.cards;
    if (!connection) break;

    (connection.nodes || []).forEach(function(node) {
      const xpCurrent = toNullableNumber_(node.xp);
      const xpNext = toNullableNumber_(node.xpNeededForNextGrade);

      allCards.push({
        slug: node.slug || '',
        ownerSince: node.ownerSince || '',
        rarity: normalizeRarityForApi_(node.rarityTyped || ''),
        inSeason: !!node.inSeasonEligible,
        salePriceEur: extractEurSalePrice_(node.liveSingleSaleOffer),
        playerSlug: node.anyPlayer && node.anyPlayer.slug ? node.anyPlayer.slug : '',
        playerName: node.anyPlayer && node.anyPlayer.displayName ? node.anyPlayer.displayName : '',
        positions: Array.isArray(node.anyPositions) ? node.anyPositions.join(', ') : '',
        level: toNullableNumber_(node.grade),
        xpCurrent: xpCurrent,
        xpCurrentGradeStart: toNullableNumber_(node.xpNeededForCurrentGrade),
        xpNext: xpNext,
        xpMissing: (xpCurrent !== '' && xpNext !== '' && xpNext !== null) ? Math.max(0, xpNext - xpCurrent) : '',
        seasonYear: toNullableNumber_(node.seasonYear),
        serialNumber: toNullableNumber_(node.serialNumber),
        feeEnabled: node.secondaryMarketFeeEnabled === true ? 'Si' : (node.secondaryMarketFeeEnabled === false ? 'No' : ''),
        photoUrl: node.pictureUrl || '',
        l5: '',
        l15: '',
        projectedClassic: '',
        projectedDaily: '',
        nextGame: '',
        nextGameDate: ''
      });
    });

    hasNextPage = !!(connection.pageInfo && connection.pageInfo.hasNextPage);
    after = hasNextPage && connection.pageInfo ? connection.pageInfo.endCursor : null;

    log_('API', userSlug, 'Pagina #' + page + ' letta, totale carte=' + allCards.length + ', hasNext=' + hasNextPage);

    if (hasNextPage) Utilities.sleep(CONFIG.pacing.betweenSorareCallsMs);
    if (isNearTimeout_(startMs)) break;
  }

  return allCards;
}

function fetchPlayerFloor_(playerSlug, rarity, inSeason) {
  const response = sorareGraphqlFetch_(QUERIES.playerFloor, {
    slug: playerSlug,
    rarity: rarity,
    inSeason: inSeason
  });

  const card = response && response.data && response.data.anyPlayer && response.data.anyPlayer.lowestPriceAnyCard;
  if (!card) return '';
  return extractEurSalePrice_(card.liveSingleSaleOffer);
}

function sorareGraphqlFetch_(query, variables) {
  let lastError = null;

  for (let attempt = 1; attempt <= CONFIG.sorare.maxHttpAttempts; attempt++) {
    try {
      incrementUrlFetchCount_('sorare');
      const response = UrlFetchApp.fetch(CONFIG.sorare.apiUrl, {
        method: 'post',
        contentType: 'application/json',
        muteHttpExceptions: true,
        headers: {
          APIKEY: CONFIG.sorare.apiKey,
          'X-Sorare-Api-Version': CONFIG.sorare.apiVersion
        },
        payload: JSON.stringify({
          query: query,
          variables: variables || {}
        })
      });

      const code = response.getResponseCode();
      const text = response.getContentText();

      if (code >= 200 && code < 300) {
        const data = JSON.parse(text);
        if (data.errors && data.errors.length) {
          throw new Error('GraphQL errors: ' + JSON.stringify(data.errors).slice(0, 1000));
        }
        return data;
      }

      if (isRetryableHttpError_(code, text)) {
        const waitMs = Math.min(20000, attempt * 4000);
        lastError = new Error('HTTP ' + code + ' - ' + text.slice(0, 500));
        log_('API', 'SORARE', 'HTTP retryable=' + code + ' | attempt=' + attempt + ' | wait=' + waitMs + 'ms');
        Utilities.sleep(waitMs);
        continue;
      }

      throw new Error('HTTP ' + code + ' - ' + text.slice(0, 500));
    } catch (e) {
      lastError = e;
      const msg = errorMessage_(e);

      if (isRetryableNetworkError_(msg) && attempt < CONFIG.sorare.maxHttpAttempts) {
        const waitMs = Math.min(20000, attempt * 4000);
        log_('API', 'SORARE', 'Errore rete retryable | attempt=' + attempt + ' | wait=' + waitMs + 'ms | ' + msg);
        Utilities.sleep(waitMs);
        continue;
      }

      throw e;
    }
  }

  throw lastError || new Error('Errore sconosciuto Sorare API');
}

function readSheetSafely_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { headers: [], rows: [] };

  const safeCols = Math.min(lastCol, CONFIG.sheets.maxReadCols);
  const values = sheet.getRange(1, 1, lastRow, safeCols).getValues();

  return {
    headers: values[0] || [],
    rows: values.slice(1)
  };
}

function batchUpdateValues_(spreadsheetId, updates, label, startMs) {
  if (!updates || !updates.length) return;

  for (let i = 0; i < updates.length; i += CONFIG.sheets.writeChunkSize) {
    const chunk = updates.slice(i, i + CONFIG.sheets.writeChunkSize);
    const chunkNumber = Math.floor(i / CONFIG.sheets.writeChunkSize) + 1;
    let success = false;
    let attempt = 0;

    while (!success && attempt < CONFIG.sheets.maxWriteAttempts) {
      attempt++;
      try {
        log_('WRITE', label, 'Batch chunk=' + chunkNumber + ' | size=' + chunk.length + ' | attempt=' + attempt);
        Sheets.Spreadsheets.Values.batchUpdate({
          valueInputOption: 'USER_ENTERED',
          data: chunk
        }, spreadsheetId);
        success = true;
      } catch (e) {
        const msg = errorMessage_(e);
        if (isWriteQuotaError_(msg)) {
          const waitMs = Math.min(15000, attempt * 3000);
          log_('WRITE', label, 'Quota write superata, wait=' + waitMs + 'ms');
          Utilities.sleep(waitMs);
        } else {
          throw e;
        }
      }
    }

    if (!success) {
      throw new Error('Impossibile completare batch update: ' + label);
    }

    Utilities.sleep(CONFIG.pacing.betweenWriteChunksMs);
    if (isNearTimeout_(startMs)) {
      log_('WRITE', label, 'Vicino timeout durante batch update');
      return;
    }
  }
}

function appendRowsChunked_(sheet, rows, width, label, startMs) {
  if (!rows || !rows.length) return;

  for (let i = 0; i < rows.length; i += CONFIG.sheets.appendChunkSize) {
    const chunk = rows.slice(i, i + CONFIG.sheets.appendChunkSize);
    const chunkNumber = Math.floor(i / CONFIG.sheets.appendChunkSize) + 1;
    let success = false;
    let attempt = 0;

    while (!success && attempt < CONFIG.sheets.maxWriteAttempts) {
      attempt++;
      try {
        log_('WRITE', label, 'Append chunk=' + chunkNumber + ' | size=' + chunk.length + ' | attempt=' + attempt);
        const startRow = sheet.getLastRow() + 1;
        sheet.insertRowsAfter(sheet.getLastRow(), chunk.length);
        sheet.getRange(startRow, 1, chunk.length, width).setValues(chunk);
        success = true;
      } catch (e) {
        const msg = errorMessage_(e);
        if (isWriteQuotaError_(msg)) {
          const waitMs = Math.min(15000, attempt * 3000);
          log_('WRITE', label, 'Quota write append superata, wait=' + waitMs + 'ms');
          Utilities.sleep(waitMs);
        } else {
          throw e;
        }
      }
    }

    if (!success) {
      throw new Error('Impossibile completare append: ' + label);
    }

    Utilities.sleep(CONFIG.pacing.betweenWriteChunksMs);
    if (isNearTimeout_(startMs)) {
      log_('WRITE', label, 'Vicino timeout durante append');
      return;
    }
  }
}

function deleteRowsDescending_(sheet, rowIndexes, scope) {
  const descending = (rowIndexes || []).slice().sort(function(a, b) { return b - a; });
  log_('LIGHT', scope, 'Carte da rimuovere=' + descending.length);

  descending.forEach(function(rowIndex, idx) {
    sheet.deleteRow(rowIndex);
    if ((idx + 1) % 20 === 0 || idx === descending.length - 1) {
      log_('LIGHT', scope, 'Delete progress=' + (idx + 1) + '/' + descending.length);
    }
    if ((idx + 1) % 10 === 0) {
      Utilities.sleep(CONFIG.pacing.betweenDeleteBurstsMs);
    }
  });
}

function buildHeaderIndexMap_(headers) {
  return {
    slug: findHeaderIndex_(headers, HEADER_ALIASES.slug),
    rarity: findHeaderIndex_(headers, HEADER_ALIASES.rarity),
    playerName: findHeaderIndex_(headers, HEADER_ALIASES.playerName),
    playerSlug: findHeaderIndex_(headers, HEADER_ALIASES.playerSlug),
    inSeason: findHeaderIndex_(headers, HEADER_ALIASES.inSeason),
    updatedAt: findHeaderIndex_(headers, HEADER_ALIASES.updatedAt),
    ownerSince: findHeaderIndex_(headers, HEADER_ALIASES.ownerSince),
    salePrice: findHeaderIndex_(headers, HEADER_ALIASES.salePrice),
    position: findHeaderIndex_(headers, HEADER_ALIASES.position),
    level: findHeaderIndex_(headers, HEADER_ALIASES.level),
    xpCurrent: findHeaderIndex_(headers, HEADER_ALIASES.xpCurrent),
    xpCurrentGradeStart: findHeaderIndex_(headers, HEADER_ALIASES.xpCurrentGradeStart),
    xpNext: findHeaderIndex_(headers, HEADER_ALIASES.xpNext),
    xpMissing: findHeaderIndex_(headers, HEADER_ALIASES.xpMissing),
    seasonYear: findHeaderIndex_(headers, HEADER_ALIASES.seasonYear),
    serialNumber: findHeaderIndex_(headers, HEADER_ALIASES.serialNumber),
    feeEnabled: findHeaderIndex_(headers, HEADER_ALIASES.feeEnabled),
    photoUrl: findHeaderIndex_(headers, HEADER_ALIASES.photoUrl),
    l5: findHeaderIndex_(headers, HEADER_ALIASES.l5),
    l15: findHeaderIndex_(headers, HEADER_ALIASES.l15),
    projectedClassic: findHeaderIndex_(headers, HEADER_ALIASES.projectedClassic),
    projectedDaily: findHeaderIndex_(headers, HEADER_ALIASES.projectedDaily),
    nextGame: findHeaderIndex_(headers, HEADER_ALIASES.nextGame),
    nextGameDate: findHeaderIndex_(headers, HEADER_ALIASES.nextGameDate),
    floorLimitedClassic: findHeaderIndex_(headers, HEADER_ALIASES.floorLimitedClassic),
    floorRareClassic: findHeaderIndex_(headers, HEADER_ALIASES.floorRareClassic),
    floorSrClassic: findHeaderIndex_(headers, HEADER_ALIASES.floorSrClassic),
    floorUniqueClassic: findHeaderIndex_(headers, HEADER_ALIASES.floorUniqueClassic),
    floorLimitedSeason: findHeaderIndex_(headers, HEADER_ALIASES.floorLimitedSeason),
    floorRareSeason: findHeaderIndex_(headers, HEADER_ALIASES.floorRareSeason),
    floorSrSeason: findHeaderIndex_(headers, HEADER_ALIASES.floorSrSeason),
    floorUniqueSeason: findHeaderIndex_(headers, HEADER_ALIASES.floorUniqueSeason)
  };
}

function validateMainSheetHeaders_(idx) {
  ['slug', 'rarity', 'playerName', 'playerSlug', 'inSeason', 'updatedAt', 'ownerSince'].forEach(function(key) {
    if (idx[key] < 0) throw new Error('Header obbligatorio mancante: ' + key);
  });
}

function validateFloorSheetHeaders_(idx) {
  if (idx.playerSlug < 0) throw new Error('Header mancante: Player API Slug');
  if (idx.rarity < 0) throw new Error('Header mancante: Rarity');
  if (idx.inSeason < 0) throw new Error('Header mancante: In Season?');
  if (idx.updatedAt < 0) throw new Error('Header mancante: Ultimo Aggiornamento');
}

function buildManagedMainRow_(headers, card) {
  const row = new Array(headers.length).fill('');

  setCellByAliases_(row, headers, HEADER_ALIASES.slug, card.slug || '');
  setCellByAliases_(row, headers, HEADER_ALIASES.rarity, card.rarity || '');
  setCellByAliases_(row, headers, HEADER_ALIASES.playerName, card.playerName || '');
  setCellByAliases_(row, headers, HEADER_ALIASES.playerSlug, card.playerSlug || '');
  setCellByAliases_(row, headers, HEADER_ALIASES.inSeason, card.inSeason ? 'Si' : 'No');
  setCellByAliases_(row, headers, HEADER_ALIASES.updatedAt, nowString_());
  setCellByAliases_(row, headers, HEADER_ALIASES.ownerSince, card.ownerSince || '');
  setCellByAliases_(row, headers, HEADER_ALIASES.salePrice, card.salePriceEur || '');
  setCellByAliases_(row, headers, HEADER_ALIASES.position, card.positions || '');
  setCellByAliases_(row, headers, HEADER_ALIASES.level, card.level);
  setCellByAliases_(row, headers, HEADER_ALIASES.xpCurrent, card.xpCurrent);
  setCellByAliases_(row, headers, HEADER_ALIASES.xpCurrentGradeStart, card.xpCurrentGradeStart);
  setCellByAliases_(row, headers, HEADER_ALIASES.xpNext, card.xpNext);
  setCellByAliases_(row, headers, HEADER_ALIASES.xpMissing, card.xpMissing);
  setCellByAliases_(row, headers, HEADER_ALIASES.seasonYear, card.seasonYear);
  setCellByAliases_(row, headers, HEADER_ALIASES.serialNumber, card.serialNumber);
  setCellByAliases_(row, headers, HEADER_ALIASES.feeEnabled, card.feeEnabled || '');
  setCellByAliases_(row, headers, HEADER_ALIASES.photoUrl, card.photoUrl || '');
  setCellByAliases_(row, headers, HEADER_ALIASES.l5, card.l5);
  setCellByAliases_(row, headers, HEADER_ALIASES.l15, card.l15);
  setCellByAliases_(row, headers, HEADER_ALIASES.projectedClassic, card.projectedClassic);
  setCellByAliases_(row, headers, HEADER_ALIASES.projectedDaily, card.projectedDaily);
  setCellByAliases_(row, headers, HEADER_ALIASES.nextGame, card.nextGame || '');
  setCellByAliases_(row, headers, HEADER_ALIASES.nextGameDate, card.nextGameDate || '');

  return row;
}

function buildRowWithFloorAndTimestamp_(existingRow, floorColIndex, floorValue, updatedAtIndex) {
  const cloned = existingRow.slice();
  cloned[floorColIndex] = floorValue;
  if (updatedAtIndex >= 0) cloned[updatedAtIndex] = nowString_();
  return cloned;
}

function mergeManagedColumnsOnly_(oldRow, newRow, headers) {
  const managedIndexes = {};

  [
    HEADER_ALIASES.slug,
    HEADER_ALIASES.rarity,
    HEADER_ALIASES.playerName,
    HEADER_ALIASES.playerSlug,
    HEADER_ALIASES.inSeason,
    HEADER_ALIASES.updatedAt,
    HEADER_ALIASES.ownerSince,
    HEADER_ALIASES.salePrice,
    HEADER_ALIASES.position,
    HEADER_ALIASES.level,
    HEADER_ALIASES.xpCurrent,
    HEADER_ALIASES.xpCurrentGradeStart,
    HEADER_ALIASES.xpNext,
    HEADER_ALIASES.xpMissing,
    HEADER_ALIASES.seasonYear,
    HEADER_ALIASES.serialNumber,
    HEADER_ALIASES.feeEnabled,
    HEADER_ALIASES.photoUrl,
    HEADER_ALIASES.l5,
    HEADER_ALIASES.l15,
    HEADER_ALIASES.projectedClassic,
    HEADER_ALIASES.projectedDaily,
    HEADER_ALIASES.nextGame,
    HEADER_ALIASES.nextGameDate
  ].forEach(function(aliasList) {
    const idx = findHeaderIndex_(headers, aliasList);
    if (idx >= 0) managedIndexes[idx] = true;
  });

  return headers.map(function(_, index) {
    return managedIndexes[index] ? newRow[index] : oldRow[index];
  });
}

function getFloorColumnIndex_(headers, rarity, inSeason) {
  const r = normalizeRarityForApi_(rarity);
  if (r === 'limited' && inSeason) return findHeaderIndex_(headers, HEADER_ALIASES.floorLimitedSeason);
  if (r === 'limited' && !inSeason) return findHeaderIndex_(headers, HEADER_ALIASES.floorLimitedClassic);
  if (r === 'rare' && inSeason) return findHeaderIndex_(headers, HEADER_ALIASES.floorRareSeason);
  if (r === 'rare' && !inSeason) return findHeaderIndex_(headers, HEADER_ALIASES.floorRareClassic);
  if (r === 'super_rare' && inSeason) return findHeaderIndex_(headers, HEADER_ALIASES.floorSrSeason);
  if (r === 'super_rare' && !inSeason) return findHeaderIndex_(headers, HEADER_ALIASES.floorSrClassic);
  if (r === 'unique' && inSeason) return findHeaderIndex_(headers, HEADER_ALIASES.floorUniqueSeason);
  if (r === 'unique' && !inSeason) return findHeaderIndex_(headers, HEADER_ALIASES.floorUniqueClassic);
  return -1;
}

function findHeaderIndex_(headers, aliases) {
  for (let i = 0; i < aliases.length; i++) {
    const idx = headers.indexOf(aliases[i]);
    if (idx >= 0) return idx;
  }
  return -1;
}

function setCellByAliases_(row, headers, aliases, value) {
  const idx = findHeaderIndex_(headers, aliases);
  if (idx >= 0) row[idx] = value;
}

function mapExistingRowsBySlug_(rows, slugIndex) {
  const map = {};
  rows.forEach(function(row, i) {
    const slug = normalizeText_(row[slugIndex]);
    if (!slug) return;
    map[slug] = { rowIndex: i + 2, row: row };
  });
  return map;
}

function mapRemoteCardsBySlug_(remoteCards) {
  const map = {};
  remoteCards.forEach(function(card) {
    map[normalizeText_(card.slug)] = card;
  });
  return map;
}

function findRowsToDelete_(existingBySlug, remoteBySlug) {
  const rows = [];
  Object.keys(existingBySlug).forEach(function(slug) {
    if (!remoteBySlug[slug]) rows.push(existingBySlug[slug].rowIndex);
  });
  return rows;
}

function rowsAreEqual_(rowA, rowB) {
  if (!rowA || !rowB || rowA.length !== rowB.length) return false;
  for (let i = 0; i < rowA.length; i++) {
    if (String(rowA[i] || '') !== String(rowB[i] || '')) return false;
  }
  return true;
}

function normalizeText_(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSeasonFlag_(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'si' ||
         normalized === 'yes' ||
         normalized === 'true' ||
         normalized === 'in-season' ||
         normalized === 'in season';
}

function normalizeRarityForApi_(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (normalized === 'limited') return 'limited';
  if (normalized === 'rare') return 'rare';
  if (normalized === 'superrare' || normalized === 'super_rare' || normalized === 'sr') return 'super_rare';
  if (normalized === 'unique') return 'unique';
  return '';
}

function floorRequestKey_(playerSlug, rarity, inSeason) {
  return 'floor|' + playerSlug + '|' + rarity + '|' + (inSeason ? 'season' : 'classic');
}

function extractEurSalePrice_(offer) {
  const amounts = offer && offer.receiverSide && offer.receiverSide.amounts;
  if (!amounts) return '';
  if (amounts.eurCents === null || typeof amounts.eurCents === 'undefined') return '';
  return parseFloat((Number(amounts.eurCents) / 100).toFixed(2));
}

function isWriteQuotaError_(msg) {
  const text = String(msg || '');
  return text.indexOf('Write requests') !== -1 ||
         text.indexOf('Quota exceeded') !== -1 ||
         text.indexOf('Rate Limit Exceeded') !== -1 ||
         text.indexOf('Too many requests') !== -1;
}

function isRetryableHttpError_(code, bodyText) {
  const body = String(bodyText || '');
  return code === 429 || code === 502 || code === 503 || code === 504 ||
         body.indexOf('Gateway Timeout') !== -1 ||
         body.indexOf('request could not be satisfied') !== -1;
}

function isRetryableNetworkError_(msg) {
  const text = String(msg || '');
  return text.indexOf('HTTP 429') !== -1 ||
         text.indexOf('HTTP 502') !== -1 ||
         text.indexOf('HTTP 503') !== -1 ||
         text.indexOf('HTTP 504') !== -1 ||
         text.indexOf('Gateway Timeout') !== -1 ||
         text.indexOf('Service invoked too many times') !== -1 ||
         text.indexOf('Address unavailable') !== -1 ||
         text.indexOf('Timed out') !== -1 ||
         text.indexOf('Connection reset') !== -1 ||
         text.indexOf('request could not be satisfied') !== -1;
}

function errorMessage_(error) {
  return String(error && error.message ? error.message : error || 'Errore sconosciuto');
}

function saveState_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(value));
}

function loadState_(key) {
  const raw = PropertiesService.getScriptProperties().getProperty(key);
  return raw ? JSON.parse(raw) : null;
}

function clearState_(key) {
  PropertiesService.getScriptProperties().deleteProperty(key);
}

function scheduleContinuation_(functionName) {
  deleteTriggersByName_(functionName);
  ScriptApp.newTrigger(functionName).timeBased().after(CONFIG.execution.continueDelayMs).create();
}

function deleteTriggersByName_(functionName) {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function deleteAllProjectTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
}

function isNearTimeout_(startMs) {
  return Date.now() - startMs >= CONFIG.execution.softLimitMs;
}

function isWithinExecutionWindow_() {
  const now = new Date();
  const hour = Number(Utilities.formatDate(now, Session.getScriptTimeZone(), 'H'));
  return hour >= CONFIG.execution.allowedStartHour && hour < CONFIG.execution.allowedEndHourExclusive;
}

function resetRuntimeStats_() {
  RUNTIME_STATS.urlFetchCalls = 0;
  RUNTIME_STATS.discordCalls = 0;
}

function incrementUrlFetchCount_(scope) {
  RUNTIME_STATS.urlFetchCalls++;

  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  const dateKey = CONFIG.stateKeys.dailyUrlFetchDate;
  const countKey = CONFIG.stateKeys.dailyUrlFetchCount;

  let savedDate = props.getProperty(dateKey);
  let count = Number(props.getProperty(countKey) || 0);

  if (savedDate !== today) {
    savedDate = today;
    count = 0;
    props.setProperty(dateKey, today);
    props.setProperty(countKey, '0');
  }

  if (count >= CONFIG.sorare.dailySafetyCap) {
    throw new Error('Safety stop UrlFetch giornalieri: ' + count + '/' + CONFIG.sorare.dailySafetyCap);
  }

  count++;
  props.setProperty(countKey, String(count));
}

function logRuntimeStats_(scope) {
  log_('STATS', scope, 'UrlFetch calls run=' + RUNTIME_STATS.urlFetchCalls + ' | Discord calls=' + RUNTIME_STATS.discordCalls);
}

function getFloorCacheKey_(playerSlug, rarity, inSeason) {
  return CONFIG.stateKeys.floorCachePrefix + floorRequestKey_(playerSlug, rarity, inSeason);
}

function getCachedFloor_(playerSlug, rarity, inSeason) {
  const raw = PropertiesService.getScriptProperties().getProperty(getFloorCacheKey_(playerSlug, rarity, inSeason));
  if (!raw) return { found: false, value: '' };

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.ts === 'undefined') return { found: false, value: '' };

    const ageMs = Date.now() - Number(parsed.ts);
    const maxAgeMs = CONFIG.sorare.floorCacheHours * 60 * 60 * 1000;
    if (ageMs > maxAgeMs) return { found: false, value: '' };

    return { found: true, value: parsed.value };
  } catch (e) {
    return { found: false, value: '' };
  }
}

function setCachedFloor_(playerSlug, rarity, inSeason, value) {
  PropertiesService.getScriptProperties().setProperty(
    getFloorCacheKey_(playerSlug, rarity, inSeason),
    JSON.stringify({ ts: Date.now(), value: value })
  );
}

function nowString_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), CONFIG.app.timezoneFormat);
}

function log_(phase, scope, message) {
  Logger.log('[' + nowString_() + '] [' + phase + '] [' + scope + '] ' + message);
}

function notifyDiscord_(gallery, text) {
  try {
    if (!gallery || !gallery.discordWebhook) return;
    if (String(gallery.discordWebhook).indexOf('INCOLLA_WEBHOOK_') !== -1) return;
    incrementUrlFetchCount_('discord');
    RUNTIME_STATS.discordCalls++;
    UrlFetchApp.fetch(gallery.discordWebhook, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify({ content: text })
    });
  } catch (e) {
    Logger.log('Discord notify error [' + (gallery ? gallery.key : '?') + ']: ' + errorMessage_(e));
  }
}

function toNullableNumber_(value) {
  if (value === null || typeof value === 'undefined' || value === '') return '';
  const n = Number(value);
  return isNaN(n) ? '' : n;
}
