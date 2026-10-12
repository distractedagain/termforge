# TFTP server

TermForge's TFTP backend is an original implementation of [RFC 1350](https://www.rfc-editor.org/info/rfc1350/). It serves octet (binary) files in 512-byte blocks, with separate UDP transfer ports, acknowledgments, retransmission limits, duplicate handling, and a final zero-length block when a file's size is a multiple of 512 bytes. A completed upload briefly keeps its transfer socket open so it can repeat the final ACK if the client lost it.

The server starts only when explicitly requested. It defaults to loopback address `127.0.0.1`, UDP port `6969`, downloads only, and one explicitly allowed client IP. A network device must support a custom server port to use the default port; standard UDP port 69 may require elevated operating-system privileges. Each transfer uses an additional ephemeral UDP port on the selected bind address. Hostnames, wildcard client addresses, and multicast client addresses are rejected.

TFTP has no authentication or encryption. Select a folder containing the files intended for that client. The IP filter limits requests to the specified address; it is not cryptographic authentication. The server does not open firewall rules or change network settings.

Files must use relative ASCII filenames. Existing subfolders are supported. Absolute paths, traversal components, drive/alternate-stream paths, control characters, Windows device aliases, and symbolic links are rejected. Transfers are limited to eight at a time and 64 MiB per file. The sharing folder is expected to remain under the user's control during service; concurrent local replacement of its folders or files is unsupported.

Uploads require explicit `allowWrite: true`. They create a private temporary file and publish a completed file atomically using an exclusive hard-link operation. Existing files are never overwritten. Partial files are removed on timeout, client error, or server stop. Upload destinations must have existing parent folders, and the filesystem must support hard links. Temporary filenames are unavailable for download. POSIX upload permissions are `0600`; Windows access follows the selected folder's ACL.

Only octet mode and classic 512-byte blocks are implemented. Well-formed optional request fields are ignored, selecting classic transfer behavior without option acknowledgments as allowed by [RFC 2347](https://www.rfc-editor.org/info/rfc2347/). Netascii, negotiated block/window sizes, resume, directory listing, and a TFTP client are not implemented.

## Backend API

```js
const { createTftpServer } = require('./app/tftp.cjs');
const server = createTftpServer({
  root: '/absolute/path/to/shared-folder',
  clientAddress: '127.0.0.1',
  bindAddress: '127.0.0.1',
  port: 6969,
  allowWrite: false,
  timeoutMs: 1000,
  retries: 5,
  onStatus: status => {},
  onTransfer: event => {},
});
const address = await server.start();
const status = server.status();
await server.stop();
```

`start()` returns the actual UDP address, family, and port. Port `0` requests an ephemeral port. `stop()` waits for all transfer operations, sockets, open files, and temporary-file cleanup. It is safe to call repeatedly, and a stopped instance can restart.

Status reports `state`, `running`, `root`, `clientAddress`, `bindAddress`, `port`, `allowWrite`, `activeTransfers`, `transfers`, `completedTransfers`, `failedTransfers`, and `lastError`. Transfer events report ID, filename, direction, client address/port, byte count, state, and message. States are `started`, `progress`, `completed`, `failed`, and `stopped`; progress is throttled to 64 KiB increments.

The automated tests use real UDP sockets only on loopback and temporary synthetic files. They cover binary downloads/uploads, zero-length termination, retries, duplicates, unexpected transfer IDs, IP filtering, filename/symlink rejection, publication collisions, transfer/file limits, partial cleanup, and socket closure. They do not establish interoperability with every network-device TFTP client or exercise a physical LAN device.
