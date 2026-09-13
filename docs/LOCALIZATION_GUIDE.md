# Adding a New Localization

This project already has a centralized i18n structure, so adding a new locale is mostly a registration task.

## 1) Create a new locale dictionary file

Create a new file:

- `src/i18n/<locale>.ts`

Use this template:

```ts
import type { I18nDictionary } from "./en.js";

export const <locale>: I18nDictionary = {
  // Copy all keys from src/i18n/en.ts
  // Fill values for the new language
};
```

Notes:

- `I18nDictionary` enforces that all keys from `en.ts` are present.
- Keep placeholders unchanged (for example: `{title}`, `{count}`, `{language}`).
- Keep formatting tokens unchanged (for example: Markdown markers, `\n`, emoji if needed).

## 2) Register the locale in the central i18n registry

Update:

- `src/i18n/index.ts`

### 2.1 Import the new dictionary

Add an import near existing locale imports:

```ts
import { <locale> } from "./<locale>.js";
```

### 2.2 Add a locale definition entry

In `LOCALE_DEFINITIONS`, add a new object:

```ts
{
  code: "<locale-code>",
  label: "<Human-readable language name>",
  dateLocale: "<BCP-47 date locale>",
  dictionary: <locale>,
},
```

Keep the existing order: `en` stays first, the rest are sorted alphabetically by
code. This array defines the order and the numbering of the language list in the
setup wizard, so inserting a locale anywhere else silently changes the wizard for
existing users. Place the import in `src/i18n/index.ts` in the same alphabetical
position.

Example fields:

- `code`: short locale code used in `BOT_LOCALE` (for example `en`, `ru`, etc.)
- `label`: display name shown in setup wizard language selection
- `dateLocale`: locale used by `toLocaleDateString` (for example `en-US`, `ru-RU`)
- `dictionary`: the imported translation object

No other type updates are needed: `Locale`, `SUPPORTED_LOCALES`, and locale options are derived automatically from this registry.

## 3) Update docs

Every new locale must be added to all four places below. Grep for an existing
code (for example `zh`) to be sure nothing was missed — the lists use different
formats, so a single search pattern does not find all of them.

`README.md`:

- the `Languages:` line near the top (native language name + code)
- the `Supported locales:` list in the `### Localization` section
- the `BOT_LOCALE` row in the environment variables table

`.env.example`:

- the `# Supported locales:` comment above `BOT_LOCALE`

Keep the same locale order in every list as in `LOCALE_DEFINITIONS`.

## 4) Verify behavior

Run quality checks:

```bash
npm run build
npm run lint
npm run typecheck
npm test
```

Manual checks:

1. Set `BOT_LOCALE=<locale-code>` in `.env` and start the bot.
2. Confirm command descriptions and user-facing texts use the new language.
3. Run the setup wizard (`opencode-telegram config`) and verify:
   - new language appears in selection list
   - selection by number and by locale code works.
4. Check date rendering in session/project related messages.

## 5) Test policy for locale additions

By default, adding a new locale dictionary and registering it does not require new tests if localization logic is unchanged.

Two existing tests keep a hand-written list of locales and must get the new one, otherwise they silently skip it:

- `tests/i18n/placeholders.test.ts` - placeholders match `en`
- `tests/i18n/callback-answer-length.test.ts` - callback answers fit Telegram's limit

Add or update tests only if you change locale resolution/normalization behavior (for example alias handling).

Relevant test files if needed:

- `tests/i18n/index.test.ts`
- `tests/config.test.ts`

## Quick checklist

- [ ] Added `src/i18n/<locale>.ts`
- [ ] Imported locale in `src/i18n/index.ts` (alphabetical position)
- [ ] Added locale entry to `LOCALE_DEFINITIONS` (`en` first, then alphabetical)
- [ ] Updated `README.md` (`Languages:` line, `Supported locales:` list, `BOT_LOCALE` table row)
- [ ] Updated `.env.example` (`# Supported locales:` comment)
- [ ] Added the locale to `tests/i18n/placeholders.test.ts` and `tests/i18n/callback-answer-length.test.ts`
- [ ] Ran `npm run build`, `npm run lint`, `npm run typecheck`, `npm test`
- [ ] Manually validated `BOT_LOCALE` and wizard language selection
