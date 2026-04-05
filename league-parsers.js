(function (globalScope) {
  function normalizeText(value) {
    return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  }

  function parseHashIdentity(rawUrl) {
    const fallback = {
      federation_code: null,
      source_club_id: null
    };

    try {
      const url = new URL(rawUrl);
      const hash = (url.hash || '').replace(/^#/, '');
      const match = hash.match(/^([A-Za-z]{2,6})\/(\d{4,8})\//);
      if (!match) return fallback;
      return {
        federation_code: (match[1] || '').toUpperCase() || null,
        source_club_id: match[2] || null
      };
    } catch (_error) {
      return fallback;
    }
  }

  function toIsoDate(ddmmyyyy) {
    const match = String(ddmmyyyy || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!match) return null;
    return `${match[3]}-${match[2]}-${match[1]}`;
  }

  function parseSeasonFromText(text) {
    const normalized = normalizeText(text);
    const seasonYearNearType = normalized.match(/\b(?:sommer|winter)\s*(20\d{2})\b/i)
      || normalized.match(/\b(20\d{2})\s*(?:sommer|winter)\b/i);
    const season_type = /\bwinter\b/i.test(normalized)
      ? 'Winter'
      : /\bsommer\b/i.test(normalized)
        ? 'Sommer'
        : null;
    const allYears = Array.from(normalized.matchAll(/\b(20\d{2})\b/g))
      .map((match) => parseInt(match[1], 10))
      .filter((year) => year >= 2010 && year <= 2100);
    const fallbackYear = allYears.length > 0 ? Math.max(...allYears) : null;

    return {
      season_year: seasonYearNearType ? parseInt(seasonYearNearType[1], 10) : fallbackYear,
      season_type
    };
  }

  function inferFederationFromPdfText(text) {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) return null;

    // Current practical mapping for this project snapshots (BTV regions/labels).
    if (
      normalized.includes('südbayern')
      || normalized.includes('suedbayern')
      || normalized.includes('nordbayern')
      || normalized.includes('bayernliga')
    ) {
      return 'BTV';
    }

    return null;
  }

  function extractGroupCode(leagueLabel) {
    const match = normalizeText(leagueLabel).match(/Gr\.\s*(\d+\s*[A-Z]{0,3})\b/i);
    if (!match) return null;
    return normalizeText(match[1]);
  }

  function splitCompetitionAndLeague(headerPrefix) {
    const prefix = normalizeText(headerPrefix);
    if (!prefix) {
      return {
        competition_label: null,
        league_name: null
      };
    }

    const keywords = [
      '2. Bundesliga',
      'Bundesliga',
      'Regionalliga',
      'Bayernliga',
      'Landesliga',
      'Südliga',
      'Verbandsliga',
      'Bezirksliga',
      'Bezirksklasse',
      'Kreisliga',
      'Freizeitliga'
    ];

    const lower = prefix.toLowerCase();
    for (const keyword of keywords) {
      const idx = lower.indexOf(keyword.toLowerCase());
      if (idx > 0) {
        return {
          competition_label: normalizeText(prefix.slice(0, idx)),
          league_name: normalizeText(prefix.slice(idx))
        };
      }
    }

    return {
      competition_label: prefix,
      league_name: null
    };
  }

  function parsePdfHeaderSegment(segment) {
    const text = normalizeText(segment);
    if (!/\bGr\./i.test(text)) return null;

    const match = text.match(/^(.*?)\s+Gr\.\s*(\d+\s*[A-Z]{0,3})\s*$/i);
    if (!match) return null;

    const prefix = normalizeText(match[1]);
    const group_code = normalizeText(match[2]);
    const split = splitCompetitionAndLeague(prefix);

    return {
      group_code,
      league_name: split.league_name,
      competition_label: split.competition_label,
      header_raw: text,
      teams: [],
      table_columns: null,
      table_matrix: null
    };
  }

  function parseTableMatrixCells(trailingSegment) {
    const text = normalizeText(trailingSegment);
    if (!text) return null;
    const tokens = text
      .split(/\s+/)
      .map((token) => normalizeText(token))
      .filter((token) => token && (token === '***' || /^\d+:\d+$/.test(token)));
    return tokens.length > 0 ? tokens : null;
  }

  function parsePdfStandingsHeaderSegment(segment) {
    const text = normalizeText(segment);
    if (!text) return null;
    if (!/Matches/i.test(text) || !/S[aä]tze?/i.test(text)) return null;

    const tokenTail = text.replace(/^.*?S[aä]tze?\s*/i, '');
    const columns = tokenTail
      .split(/\s+/)
      .map((token) => normalizeText(token))
      .filter((token) => /^\d+$/.test(token));

    return columns.length > 0 ? columns : null;
  }

  function parsePdfTeamSegment(segment) {
    const text = normalizeText(segment);
    const match = text.match(/^(\d{1,2})\s+(.+?)\s+\((\d{4,8})\)(?:\s+(\d+:\d+)\s+(\d+:\d+)\s+(\d+:\d+))?(?:\s+(.+))?$/i);
    if (!match) return null;

    return {
      rank: parseInt(match[1], 10),
      team_label: normalizeText(match[2]),
      source_club_id: match[3],
      points_text: match[4] || null,
      matches_text: match[5] || null,
      sets_text: match[6] || null,
      matrix_cells: parseTableMatrixCells(match[7] || ''),
      raw_team_text: text
    };
  }

  function parseRankedTeamLine(line) {
    const segments = String(line || '')
      .split(/\s{4,}/)
      .map((segment) => normalizeText(segment))
      .filter(Boolean);
    if (segments.length === 0) return [];

    const direct = segments
      .map((segment) => parsePdfTeamSegment(segment))
      .filter((team) => team && (
        team.points_text
        || team.matches_text
        || team.sets_text
        || (Array.isArray(team.matrix_cells) && team.matrix_cells.length > 0)
      ));
    if (direct.length > 0) return direct;

    const out = [];
    for (let idx = 0; idx + 3 < segments.length; idx += 4) {
      const identity = segments[idx];
      const points = segments[idx + 1];
      const matchesAndSets = segments[idx + 2];
      const matrix = segments[idx + 3];

      const identityMatch = identity.match(/^(\d{1,2})\s+(.+?)\s+\((\d{4,8})\)$/);
      const pointsMatch = points.match(/^\d+:\d+$/);
      const summaryMatch = matchesAndSets.match(/^(\d+:\d+)\s+(\d+:\d+)$/);
      if (!identityMatch || !pointsMatch || !summaryMatch) continue;

      out.push({
        rank: parseInt(identityMatch[1], 10),
        team_label: normalizeText(identityMatch[2]),
        source_club_id: identityMatch[3],
        points_text: points,
        matches_text: summaryMatch[1],
        sets_text: summaryMatch[2],
        matrix_cells: parseTableMatrixCells(matrix),
        raw_team_text: normalizeText(`${identity} ${points} ${matchesAndSets} ${matrix}`)
      });
    }

    return out;
  }

  function parsePdfTeamNameOnlySegment(segment) {
    const text = normalizeText(segment);
    const match = text.match(/^(.+?)\s+\((\d{4,8})\)\s*$/);
    if (!match) return null;

    const teamLabel = normalizeText(match[1]);
    if (!teamLabel) return null;
    // Skip page/report metadata lines that happen to include parentheses.
    if (/^(Südbayern|Nordbayern|nu\.?Dokument|Ergebnistabellen)/i.test(teamLabel)) return null;

    return {
      rank: null,
      team_label: teamLabel,
      source_club_id: match[2],
      points_text: null,
      matches_text: null,
      sets_text: null,
      raw_team_text: text
    };
  }

  function decodePdfLiteralToken(tokenBody) {
    if (!tokenBody) return '';
    let out = '';
    for (let i = 0; i < tokenBody.length; i += 1) {
      const ch = tokenBody[i];
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const next = tokenBody[i + 1];
      if (!next) break;
      if (next === 'n') {
        out += '\n';
        i += 1;
        continue;
      }
      if (next === 'r') {
        out += '\r';
        i += 1;
        continue;
      }
      if (next === 't') {
        out += '\t';
        i += 1;
        continue;
      }
      if (/[0-7]/.test(next)) {
        const octal = (tokenBody.slice(i + 1, i + 4).match(/^[0-7]{1,3}/) || [''])[0];
        if (octal) {
          out += String.fromCharCode(parseInt(octal, 8));
          i += octal.length;
          continue;
        }
      }
      out += next;
      i += 1;
    }
    return out;
  }

  function extractLiteralStringsFromPdfText(rawText) {
    const text = String(rawText || '');
    if (!text) return [];
    const out = [];
    const re = /\(((?:\\.|[^\\()]){2,})\)/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      const decoded = normalizeText(decodePdfLiteralToken(match[1]));
      if (!decoded) continue;
      // Keep only reasonably human lines; ignore font/object names.
      if (!/[A-Za-zÄÖÜäöüß0-9]/.test(decoded)) continue;
      out.push(decoded);
    }
    return out;
  }

  async function inflatePdfStreamBytes(streamBytes) {
    if (!streamBytes || !streamBytes.length) return null;
    if (typeof DecompressionStream === 'undefined' || typeof Response === 'undefined' || typeof Blob === 'undefined') {
      return null;
    }

    const encodings = ['deflate', 'deflate-raw'];
    for (const encoding of encodings) {
      try {
        const blob = new Blob([streamBytes]);
        const decompressedStream = blob.stream().pipeThrough(new DecompressionStream(encoding));
        const buffer = await new Response(decompressedStream).arrayBuffer();
        return new Uint8Array(buffer);
      } catch (_error) {
        // Try next codec.
      }
    }
    return null;
  }

  async function extractPdfTextFromBytes(pdfBytes) {
    if (!pdfBytes) return '';
    const bytes = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
    if (!bytes.length) return '';

    const decoder = new TextDecoder('latin1');
    const pdfText = decoder.decode(bytes);
    const literalChunks = [];

    literalChunks.push(...extractLiteralStringsFromPdfText(pdfText));

    const streamStartPattern = /<<[\s\S]*?\/Filter\s*\/FlateDecode[\s\S]*?>>\s*stream\r?\n/g;
    let match;
    while ((match = streamStartPattern.exec(pdfText)) !== null) {
      const streamStart = match.index + match[0].length;
      const endIdx = pdfText.indexOf('endstream', streamStart);
      if (endIdx <= streamStart) continue;

      let streamEnd = endIdx;
      while (streamEnd > streamStart && (bytes[streamEnd - 1] === 0x0a || bytes[streamEnd - 1] === 0x0d)) {
        streamEnd -= 1;
      }
      const rawStream = bytes.slice(streamStart, streamEnd);
      const inflated = await inflatePdfStreamBytes(rawStream);
      if (!inflated || !inflated.length) continue;

      const inflatedText = decoder.decode(inflated);
      literalChunks.push(...extractLiteralStringsFromPdfText(inflatedText));
    }

    return literalChunks.join('\n');
  }

  function parseLeagueTablesPdfText(pdfText, context = {}) {
    const sourceUrl = context.source_url || context.sourceUrl || null;
    const hashIdentity = parseHashIdentity(sourceUrl || '');

    const source = normalizeText(pdfText)
      ? String(pdfText).normalize('NFC')
      : '';

    const lines = source
      .split(/\r?\n/)
      .map((line) => line.replace(/\u000c/g, '').replace(/\s+$/g, ''));

    let season_year = context.season_year ?? null;
    let season_type = context.season_type ?? null;
    let source_club_id = context.source_club_id || hashIdentity.source_club_id || null;

    const groups = [];
    const groupByCode = new Map();
    let currentGroupCodes = [];

    for (const rawLine of lines) {
      const line = rawLine || '';
      const compact = normalizeText(line);
      if (!compact) continue;

      if (!season_type || !season_year) {
        const parsedSeason = parseSeasonFromText(compact);
        season_type = season_type || parsedSeason.season_type;
        season_year = season_year || parsedSeason.season_year;
      }

      if (!source_club_id) {
        const clubIdMatch = compact.match(/\((\d{4,8})\)\s*$/);
        if (clubIdMatch) source_club_id = clubIdMatch[1];
      }

      const headerSegments = line
        .split(/\s{4,}/)
        .map((segment) => normalizeText(segment))
        .filter((segment) => segment && /\bGr\./i.test(segment));

      if (headerSegments.length > 0) {
        currentGroupCodes = [];
        for (const segment of headerSegments) {
          const parsedHeader = parsePdfHeaderSegment(segment);
          if (!parsedHeader?.group_code) continue;

          const existing = groupByCode.get(parsedHeader.group_code);
          if (existing) {
            if (!existing.league_name && parsedHeader.league_name) {
              existing.league_name = parsedHeader.league_name;
            }
            if (!existing.competition_label && parsedHeader.competition_label) {
              existing.competition_label = parsedHeader.competition_label;
            }
            if (!existing.header_raw) {
              existing.header_raw = parsedHeader.header_raw;
            }
          } else {
            groups.push(parsedHeader);
            groupByCode.set(parsedHeader.group_code, parsedHeader);
          }
          currentGroupCodes.push(parsedHeader.group_code);
        }
        continue;
      }

      if (currentGroupCodes.length > 0) {
        const standingsSegments = line
          .split(/\s{4,}/)
          .map((segment) => normalizeText(segment))
          .filter(Boolean);
        let standingsSegmentCount = 0;
        for (let idx = 0; idx < standingsSegments.length; idx += 1) {
          const columns = parsePdfStandingsHeaderSegment(standingsSegments[idx]);
          if (!columns) continue;
          standingsSegmentCount += 1;
          const groupCode = currentGroupCodes[idx] || currentGroupCodes[0] || null;
          if (!groupCode) continue;
          const group = groupByCode.get(groupCode);
          if (!group) continue;
          if (!Array.isArray(group.table_columns) || group.table_columns.length === 0) {
            group.table_columns = columns;
          }
        }
        if (standingsSegmentCount > 0) continue;
      }

      const looksLikeRankedTeamRow = /^\s*\d{1,2}\s+/.test(line);
      if (!looksLikeRankedTeamRow) {
        if (currentGroupCodes.length > 0) {
          const fallbackNameOnly = parsePdfTeamNameOnlySegment(compact);
          if (fallbackNameOnly) {
            const group = groupByCode.get(currentGroupCodes[0]);
            if (group && !group.teams.find((team) => team.team_label === fallbackNameOnly.team_label && team.source_club_id === fallbackNameOnly.source_club_id)) {
              group.teams.push(fallbackNameOnly);
            }
          }
        }
        continue;
      }

      const parsedTeams = parseRankedTeamLine(line);
      let parsedCount = 0;
      for (let idx = 0; idx < parsedTeams.length; idx += 1) {
        const parsedTeam = parsedTeams[idx];
        if (!parsedTeam) continue;
        parsedCount += 1;

        const groupCode = currentGroupCodes[idx] || currentGroupCodes[0] || null;
        if (!groupCode) continue;

        const group = groupByCode.get(groupCode);
        if (!group) continue;

        const duplicate = group.teams.find((team) => team.rank === parsedTeam.rank && team.team_label === parsedTeam.team_label);
        if (!duplicate) group.teams.push(parsedTeam);
      }

      if (parsedCount === 0 && currentGroupCodes.length > 0) {
        const fallbackMatch = parsePdfTeamSegment(compact);
        if (fallbackMatch) {
          const group = groupByCode.get(currentGroupCodes[0]);
          if (group && !group.teams.find((team) => team.rank === fallbackMatch.rank && team.team_label === fallbackMatch.team_label)) {
            group.teams.push(fallbackMatch);
          }
          continue;
        }

      }
    }

    for (const group of groups) {
      const matrixRows = (group.teams || [])
        .filter((team) => Array.isArray(team.matrix_cells) && team.matrix_cells.length > 0)
        .map((team) => ({
          rank: Number.isInteger(team.rank) ? team.rank : null,
          team_label: team.team_label || null,
          source_club_id: team.source_club_id || null,
          cells: team.matrix_cells
        }));

      group.table_matrix = matrixRows.length > 0
        ? {
            format: 'cross-table',
            columns: (() => {
              if (Array.isArray(group.table_columns) && group.table_columns.length > 0) {
                return group.table_columns;
              }
              const inferredLength = matrixRows.reduce((max, row) => {
                const len = Array.isArray(row.cells) ? row.cells.length : 0;
                return Math.max(max, len);
              }, 0);
              if (inferredLength <= 0) return null;
              return Array.from({ length: inferredLength }, (_unused, idx) => String(idx + 1));
            })(),
            rows: matrixRows
          }
        : null;

      for (const team of group.teams || []) {
        delete team.matrix_cells;
      }
      delete group.table_columns;
    }

    return {
      federation_code: context.federation_code || hashIdentity.federation_code || inferFederationFromPdfText(source) || null,
      season_year,
      season_type,
      source_club_id: source_club_id || null,
      source_url: sourceUrl,
      groups
    };
  }

  async function parseLeagueTablesPdfBytes(pdfBytes, context = {}) {
    const extractedText = await extractPdfTextFromBytes(pdfBytes);
    const parsed = parseLeagueTablesPdfText(extractedText, context);
    return {
      ...parsed,
      pdf_text: extractedText
    };
  }

  function parseVereinsspielplanFromDocument(doc, sourceUrl) {
    if (!doc || !doc.querySelectorAll) {
      return {
        federation_code: null,
        source_club_id: null,
        season_year: null,
        season_type: null,
        source_url: sourceUrl || null,
        columns: [],
        fixtures: []
      };
    }

    const hashIdentity = parseHashIdentity(sourceUrl || doc.location?.href || '');

    const selectedSeasonText = normalizeText(
      doc.querySelector('select.z-select option:checked')?.textContent ||
      doc.querySelector('select option:checked')?.textContent ||
      ''
    );
    const parsedSeason = parseSeasonFromText(selectedSeasonText);

    const grids = Array.from(doc.querySelectorAll('.clubview-grid.z-grid'));
    const mainGrid = grids
      .map((grid) => {
        const headers = Array.from(grid.querySelectorAll('th.z-column .z-toolbarbutton-content'))
          .map((node) => normalizeText(node.textContent))
          .filter(Boolean);
        const hasGroupLabels = headers.some((value) => /\bGr\./i.test(value));
        return { grid, headers, score: hasGroupLabels ? headers.length : 0 };
      })
      .sort((a, b) => b.score - a.score)[0]?.grid || null;

    const columns = [];
    if (mainGrid) {
      const thNodes = Array.from(mainGrid.querySelectorAll('th.z-column'));
      for (const th of thNodes) {
        const values = Array.from(th.querySelectorAll('.z-toolbarbutton-content'))
          .map((node) => normalizeText(node.textContent))
          .filter(Boolean);
        if (values.length === 0) continue;

        const team_label_with_age = values[0] || null;
        const league_label = values.find((value) => /\bGr\./i.test(value)) || values[1] || null;
        const group_code = extractGroupCode(league_label);
        if (!team_label_with_age && !league_label) continue;

        columns.push({
          team_label_with_age,
          league_label,
          group_code
        });
      }
    }

    const dateGrid = grids.find((grid) => {
      if (!grid.classList.contains('noscroll')) return false;
      return /\d{2}\.\d{2}\.\d{4}/.test(normalizeText(grid.textContent));
    }) || null;

    const dateRows = dateGrid
      ? Array.from(dateGrid.querySelectorAll('.z-grid-body .z-rows > tr, .z-rows > tr')).map((row) => {
        const text = normalizeText(row.textContent);
        const dateMatch = text.match(/(\d{2}\.\d{2}\.\d{4})/);
        return dateMatch ? toIsoDate(dateMatch[1]) : null;
      })
      : [];

    const explicitYear = dateRows
      .map((iso) => {
        const match = String(iso || '').match(/^(\d{4})-/);
        return match ? parseInt(match[1], 10) : null;
      })
      .find((year) => Number.isInteger(year)) || null;
    const bodyYearMatch = normalizeText(doc.body?.innerText || '').match(/\b(20\d{2})\b/);
    const bodyYear = bodyYearMatch ? parseInt(bodyYearMatch[1], 10) : null;

    const mainRows = mainGrid
      ? Array.from(mainGrid.querySelectorAll('.z-grid-body .z-rows > tr, .z-rows > tr'))
      : [];

    const fixtures = [];

    for (let rowIdx = 0; rowIdx < mainRows.length; rowIdx += 1) {
      const row = mainRows[rowIdx];
      const matchDate = dateRows[rowIdx] || null;
      const cells = Array.from(row.querySelectorAll('td.z-cell'));

      for (let colIdx = 0; colIdx < columns.length; colIdx += 1) {
        const cell = cells[colIdx];
        if (!cell) continue;

        const raw_cell_text = normalizeText(cell.textContent);
        if (!raw_cell_text) continue;

        const labelTexts = Array.from(cell.querySelectorAll('.z-label'))
          .map((node) => normalizeText(node.textContent))
          .filter(Boolean);
        const scheduleTextCandidates = [raw_cell_text, ...labelTexts].join(' | ');
        const markerMatch = scheduleTextCandidates.match(/\(([HA])\)/i);
        const timeMatch = scheduleTextCandidates.match(/\b([0-2]?\d[:.][0-5]\d)\b/);
        const normalizedTime = timeMatch
          ? `${String(parseInt(timeMatch[1].split(/[:.]/)[0], 10)).padStart(2, '0')}:${timeMatch[1].split(/[:.]/)[1]}`
          : null;

        const hasScheduleSignal = !!normalizedTime || !!markerMatch;
        const hasOpponentSignal = !!cell.querySelector('.z-toolbarbutton-content');
        if (!hasScheduleSignal && !hasOpponentSignal) continue;

        const opponentText = normalizeText(cell.querySelector('.z-toolbarbutton-content')?.textContent || '');
        const resultMatch = raw_cell_text.match(/\b(\d{1,2}:\d{1,2}(?:\s+\d{1,2}:\d{1,2})*)\b/);

        const status = /abgesagt|verlegt|verschoben/i.test(raw_cell_text)
          ? 'postponed'
          : resultMatch
            ? 'played'
            : hasScheduleSignal
              ? 'scheduled'
              : 'unknown';

        fixtures.push({
          group_code: columns[colIdx]?.group_code || null,
          date: matchDate,
          time: normalizedTime,
          opponent_team_label: opponentText || null,
          is_home_for_main_club: markerMatch ? markerMatch[1].toUpperCase() === 'H' : null,
          result_text: resultMatch ? resultMatch[1] : null,
          status,
          raw_cell_text
        });
      }
    }

    return {
      federation_code: hashIdentity.federation_code || null,
      source_club_id: hashIdentity.source_club_id || null,
      season_year: parsedSeason.season_year || explicitYear || bodyYear || null,
      season_type: parsedSeason.season_type || null,
      source_url: sourceUrl || doc.location?.href || null,
      columns,
      fixtures
    };
  }

  function parseVereinsspielplanFromHtml(html, sourceUrl) {
    const source = String(html || '');
    const resolvedSourceUrl = sourceUrl || (source.match(/^Url:\s*(\S+)/m)?.[1] || null);
    const hashIdentity = parseHashIdentity(resolvedSourceUrl || '');

    const selectedSeasonMatch = source.match(/<option[^>]*selected[^>]*>\s*(Sommer|Winter)\s*<\/option>/i);
    const season_type = selectedSeasonMatch
      ? selectedSeasonMatch[1][0].toUpperCase() + selectedSeasonMatch[1].slice(1).toLowerCase()
      : null;

    const dateMatches = Array.from(source.matchAll(/(\d{2}\.\d{2}\.20\d{2})/g));
    const season_year = dateMatches[0] ? parseInt(dateMatches[0][1].slice(-4), 10) : null;

    const columns = [];
    const leagueMatches = Array.from(
      source.matchAll(/class="z-toolbarbutton-content">\s*([\s\S]*?Gr\.\s*\d+\s*[A-Z]{0,3}[\s\S]*?)<\/span>/gi)
    );
    for (const match of leagueMatches) {
      const league = normalizeText(match[1]);
      const groupCode = extractGroupCode(league);
      if (!groupCode) continue;

      const before = source.slice(Math.max(0, match.index - 500), match.index);
      const teamCandidates = Array.from(before.matchAll(/class="z-toolbarbutton-content">\s*([\s\S]*?)<\/span>/gi))
        .map((candidate) => normalizeText(candidate[1]))
        .filter((value) => value && !/\bGr\./i.test(value));
      const team = teamCandidates[teamCandidates.length - 1] || null;

      const duplicate = columns.find((column) => column.group_code === groupCode && column.team_label_with_age === team);
      if (duplicate) continue;
      columns.push({
        team_label_with_age: team,
        league_label: league,
        group_code: groupCode
      });
    }

    const fixtures = [];
    const plainText = normalizeText(
      source
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    );
    const markerRegex = /(\d{1,2}:\d{2})\s*\(([HA])\)/gi;
    let markerMatch;
    while ((markerMatch = markerRegex.exec(plainText)) !== null) {
      fixtures.push({
        group_code: null,
        date: null,
        time: markerMatch[1],
        opponent_team_label: null,
        is_home_for_main_club: markerMatch[2].toUpperCase() === 'H',
        result_text: null,
        status: 'scheduled',
        raw_cell_text: normalizeText(`${markerMatch[1]} (${markerMatch[2]})`)
      });
    }

    return {
      federation_code: hashIdentity.federation_code || null,
      source_club_id: hashIdentity.source_club_id || null,
      season_year,
      season_type,
      source_url: resolvedSourceUrl,
      columns,
      fixtures
    };
  }

  const api = {
    normalizeText,
    parseHashIdentity,
    extractGroupCode,
    inferFederationFromPdfText,
    extractPdfTextFromBytes,
    parseLeagueTablesPdfText,
    parseLeagueTablesPdfBytes,
    parseVereinsspielplanFromDocument,
    parseVereinsspielplanFromHtml
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  globalScope.LeagueParsers = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
