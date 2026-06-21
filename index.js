// Tavo Chat Importer for SillyTavern
// Imports chat exports from Tavo (.jsonl) into a SillyTavern character as a new chat file.
//
// Tavo's export format is already extremely close to SillyTavern's native chat JSONL format:
//   line 1: { user_name, character_name, create_date, chat_metadata }
//   line N: { name, is_user, is_system, send_date, mes, extra }
// So the conversion mostly just needs to normalize a couple of fields (dates) and
// write the result through SillyTavern's own /api/chats/save endpoint.

import { getContext } from '../../../extensions.js';

const MODULE_NAME = 'tavoChatImporter';

let lastParsed = null; // { header, messages, raw } of the most recently loaded file

function sanitizeFileName(name) {
    return String(name ?? 'chat')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100) || 'chat';
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

// Mimics SillyTavern's own "YYYY-M-D@HhMmSs" style used in chat header create_date fields.
// This value is metadata only and is not strictly parsed back by the client, so an approximate
// but well-formed value is sufficient.
function buildCreateDateString(date = new Date()) {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}` +
        `@${pad2(date.getHours())}h${pad2(date.getMinutes())}m${pad2(date.getSeconds())}s`;
}

// Tavo stores send_date as a local ISO-like string ("2026-06-21T19:21:00.000").
// SillyTavern's current chat format uses Unix epoch milliseconds for send_date.
function normalizeSendDate(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) {
            return parsed;
        }
    }
    return Date.now();
}

function notify(type, message) {
    if (typeof toastr !== 'undefined') {
        toastr[type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'success'](message, 'Tavo Chat Importer');
    }
    setStatus(message, type);
}

function setStatus(message, type = 'info') {
    const $status = $('#tavo_import_status');
    if (!$status.length) return;
    $status.text(message);
    $status.css('color', type === 'error' ? '#e26d6d' : type === 'warning' ? '#e2b86d' : 'inherit');
}

/**
 * Parses raw Tavo .jsonl text into a header object and an array of message objects.
 * @param {string} text Raw file contents
 * @returns {{header: object, messages: object[]}}
 */
function parseTavoExport(text) {
    // Strip BOM if present, split into non-empty lines.
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim().length > 0);

    if (lines.length === 0) {
        throw new Error('Файл пустой.');
    }

    let header;
    try {
        header = JSON.parse(lines[0]);
    } catch (err) {
        throw new Error('Не удалось разобрать первую строку файла (заголовок чата). Это точно экспорт из Tavo?');
    }

    if (!header || typeof header !== 'object' || !('character_name' in header)) {
        throw new Error('Заголовок файла не похож на экспорт чата Tavo (нет поля character_name).');
    }

    const messages = [];
    const errors = [];
    for (let i = 1; i < lines.length; i++) {
        try {
            const msg = JSON.parse(lines[i]);
            if (msg && typeof msg === 'object' && 'mes' in msg) {
                messages.push(msg);
            } else {
                errors.push(i + 1);
            }
        } catch (err) {
            errors.push(i + 1);
        }
    }

    if (errors.length > 0) {
        console.warn(`[Tavo Chat Importer] Пропущено ${errors.length} некорректных строк: ${errors.join(', ')}`);
    }

    if (messages.length === 0) {
        throw new Error('В файле не найдено ни одного сообщения.');
    }

    return { header, messages };
}

/**
 * Converts parsed Tavo data into a SillyTavern-native chat array (header + messages),
 * ready to be sent to /api/chats/save.
 */
function buildStChat(header, messages, targetCharacter, userName) {
    const stHeader = {
        user_name: userName || header.user_name || 'User',
        character_name: targetCharacter.name,
        create_date: buildCreateDateString(),
        chat_metadata: (header.chat_metadata && typeof header.chat_metadata === 'object') ? header.chat_metadata : {},
    };

    const stMessages = messages.map(m => {
        const isUser = Boolean(m.is_user);
        const out = {
            name: m.name || (isUser ? stHeader.user_name : targetCharacter.name),
            is_user: isUser,
            is_system: Boolean(m.is_system),
            send_date: normalizeSendDate(m.send_date),
            mes: typeof m.mes === 'string' ? m.mes : '',
        };
        if (m.extra && typeof m.extra === 'object' && Object.keys(m.extra).length > 0) {
            out.extra = m.extra;
        }
        return out;
    });

    return [stHeader, ...stMessages];
}

async function saveAsNewChat(chatArray, targetCharacter) {
    const context = getContext();
    const fileName = sanitizeFileName(`${targetCharacter.name} - Tavo Import - ${Date.now()}`);

    const response = await fetch('/api/chats/save', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            ch_name: targetCharacter.name,
            avatar_url: targetCharacter.avatar,
            file_name: fileName,
            chat: chatArray,
            force: true,
        }),
    });

    if (!response.ok) {
        let detail = '';
        try { detail = await response.text(); } catch (e) { /* ignore */ }
        throw new Error(`Сервер ответил ошибкой ${response.status}. ${detail}`.trim());
    }

    return fileName;
}

async function tryOpenChat(targetCharacter, fileName) {
    const context = getContext();
    try {
        const charIndex = context.characters.findIndex(c => c.avatar === targetCharacter.avatar);
        if (charIndex === -1) return false;

        if (typeof context.selectCharacterById === 'function') {
            await context.selectCharacterById(charIndex);
        }
        if (typeof context.openCharacterChat === 'function') {
            await context.openCharacterChat(fileName);
        }
        return true;
    } catch (err) {
        console.error('[Tavo Chat Importer] Не удалось автоматически открыть чат:', err);
        return false;
    }
}

function populateCharacterSelect() {
    const context = getContext();
    const $select = $('#tavo_target_character');
    const previousValue = $select.val();
    $select.empty();
    $select.append($('<option>', { value: '', text: '— Выберите персонажа —' }));

    const characters = Array.isArray(context.characters) ? context.characters : [];
    characters.forEach((c, idx) => {
        $select.append($('<option>', { value: c.avatar, text: c.name, 'data-index': idx }));
    });

    if (previousValue) {
        $select.val(previousValue);
    }

    return characters;
}

function autoSelectMatchingCharacter(characterName) {
    if (!characterName) return;
    const $select = $('#tavo_target_character');
    const target = String(characterName).trim().toLowerCase();
    let matched = false;
    $select.find('option').each(function () {
        const optText = $(this).text().trim().toLowerCase();
        if (optText === target) {
            $select.val($(this).val());
            matched = true;
            return false;
        }
    });
    return matched;
}

function handleFileSelected(file) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
        try {
            const text = String(reader.result);
            const { header, messages } = parseTavoExport(text);
            lastParsed = { header, messages };

            populateCharacterSelect();
            const matched = autoSelectMatchingCharacter(header.character_name);

            const matchNote = matched
                ? ''
                : ` Персонаж «${header.character_name}» не найден в списке — выберите подходящего вручную или создайте/импортируйте такого персонажа сначала.`;

            setStatus(
                `Загружено: ${messages.length} сообщ., персонаж в файле — «${header.character_name}», пользователь — «${header.user_name || '?'}».${matchNote}`,
                matched ? 'info' : 'warning',
            );
        } catch (err) {
            lastParsed = null;
            notify('error', err.message || String(err));
        }
    };
    reader.onerror = () => {
        lastParsed = null;
        notify('error', 'Не удалось прочитать файл.');
    };
    reader.readAsText(file, 'utf-8');
}

async function handleImportClick() {
    if (!lastParsed) {
        notify('error', 'Сначала выберите файл экспорта Tavo (.jsonl).');
        return;
    }

    const context = getContext();
    const avatarUrl = $('#tavo_target_character').val();
    if (!avatarUrl) {
        notify('error', 'Выберите персонажа, в которого нужно импортировать чат.');
        return;
    }

    const targetCharacter = (context.characters || []).find(c => c.avatar === avatarUrl);
    if (!targetCharacter) {
        notify('error', 'Не удалось найти выбранного персонажа. Обновите страницу и попробуйте снова.');
        return;
    }

    const openAfter = $('#tavo_open_after').is(':checked');

    const $button = $('#tavo_import_button');
    $button.prop('disabled', true);
    setStatus('Импортирую…', 'info');

    try {
        const chatArray = buildStChat(lastParsed.header, lastParsed.messages, targetCharacter, context.name1);
        const fileName = await saveAsNewChat(chatArray, targetCharacter);

        notify('success', `Чат импортирован как новый файл для «${targetCharacter.name}» (${lastParsed.messages.length} сообщ.).`);

        if (openAfter) {
            const opened = await tryOpenChat(targetCharacter, fileName);
            if (!opened) {
                setStatus(`Чат сохранён (${fileName}), но не удалось открыть его автоматически. Откройте его через «Manage chat files» у персонажа «${targetCharacter.name}».`, 'warning');
            }
        }
    } catch (err) {
        console.error('[Tavo Chat Importer]', err);
        notify('error', `Ошибка импорта: ${err.message || err}`);
    } finally {
        $button.prop('disabled', false);
    }
}

function buildSettingsHtml() {
    return `
    <div class="tavo-importer-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Tavo Chat Importer</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="tavo-field">
                    <label for="tavo_file_input">Файл экспорта Tavo (.jsonl)</label>
                    <input id="tavo_file_input" type="file" accept=".jsonl,.json,.txt" />
                </div>
                <div class="tavo-field">
                    <label for="tavo_target_character">Импортировать в персонажа</label>
                    <select id="tavo_target_character"></select>
                </div>
                <div class="tavo-field tavo-checkbox-row">
                    <label>
                        <input id="tavo_open_after" type="checkbox" checked />
                        Открыть чат сразу после импорта
                    </label>
                </div>
                <div class="tavo-field">
                    <button id="tavo_import_button" class="menu_button">Импортировать чат</button>
                </div>
                <div id="tavo_import_status" class="tavo-status"></div>
                <div class="tavo-hint">
                    Импорт создаёт <b>новый</b> файл чата у выбранного персонажа — существующие чаты не затрагиваются.
                    Если нужного персонажа ещё нет, создайте или импортируйте его в SillyTavern, затем выберите его здесь.
                </div>
            </div>
        </div>
    </div>`;
}

jQuery(async () => {
    $('#extensions_settings2').append(buildSettingsHtml());

    populateCharacterSelect();

    $('.tavo-importer-settings .inline-drawer-toggle').on('click', () => {
        // Refresh the character list every time the drawer is opened,
        // in case characters were added/removed since page load.
        populateCharacterSelect();
        if (lastParsed) {
            autoSelectMatchingCharacter(lastParsed.header.character_name);
        }
    });

    $('#tavo_file_input').on('change', function (e) {
        const file = e.target.files && e.target.files[0];
        handleFileSelected(file);
    });

    $('#tavo_import_button').on('click', handleImportClick);
});
