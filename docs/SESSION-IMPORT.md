# Import sessions from text

ForgeCRT 0.13 enables **Tools → Import Settings from Text File** and **Import & export → Import sessions from CSV or text**. This wizard imports connection profiles; it does not import all SecureCRT settings or encrypted secrets.

Choose a regular UTF-8 file, including UTF-8 with a BOM. Select comma, tab or semicolon delimiters and whether the first row contains column names. Quoted fields support escaped quotes and embedded line breaks. A one-column host list also works: turn off the header option and map that column to Host. Missing session names use the hostname.

Map the columns for Host, Session name, Protocol, Port, Username, Folder and Description. SSH/SSH2, SFTP, Telnet and Raw TCP are supported. Local shell commands, serial settings, private-key paths, passwords and credential references are not import fields. Recognized password/key/token/credential column headers are protected from mapping. Arbitrary values in headerless files cannot be identified as secrets automatically; review the mapped values before saving.

Click **Preview import** to inspect every row. Malformed quoting, inconsistent column counts, unsupported protocols and invalid session fields produce line-specific errors. Nothing is saved while selected rows contain errors. Correct the mapping or explicitly uncheck the invalid rows; **Select valid rows** makes that exclusion explicit. Preview again after changing any options or selection.

Choose a collision policy for matching folder and session names; matching normalizes Unicode and ignores letter case:

- **Skip duplicates** leaves an existing or earlier imported match unchanged.
- **Import with a unique name** adds a numeric suffix to make a new profile.
- **Replace saved settings (keep ID)** replaces the complete profile with imported values and defaults, clearing credential references. Its identifier stays the same, so snapshots still refer to it. Ambiguous duplicate matches are rejected.

After reviewing the preview, click **Import selected sessions** and confirm the counts in the native dialog. Saved sessions are checked again before one atomic configuration write. If sessions changed after preview, the import stops and requires a fresh preview. Other current preferences, commands and snapshots are retained. Importing never opens a connection or changes its source file. Already-open terminals keep their current connection settings until reconnected.

Files are limited to 2 MiB, 32 columns, 8,192 characters per field and 2,000 data rows. The final configuration remains limited to 1,000 saved sessions. Import previews expire after 15 minutes and are discarded when the wizard is canceled or the app closes. Only the reviewed profiles are persisted; source file contents and preview tokens are temporary.

This independent workflow is informed by [VanDyke's text import wizard documentation](https://www.vandyke.com/support/tips/import-securecrt-sessions-from-csv-or-text-file-data-using-text-import-wizard.html). SecureCRT XML configuration import, arbitrary encodings, custom field catalogs and encrypted-password migration remain unavailable.
