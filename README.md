# dhub-mirroring-service
A dHub service with a RPC API for mirroring.

## Installation
```
npm i dhub-mirroring-service
```

## Usage
This service is meant to run alongside a running dHub server.

With dHub running in a separate terminal:
```sh
❯ ./bin/index.js
Running dhub-mirror/1.0.6 linux-x64 node-v14.15.0
Listening on /tmp/dhub-mirroring.sock
```

Then you can import `dhub-mirroring-service/client` inside a script, and it will auto-connect to the running server.

The mirror service provides an [DRPC](https://github.com/dwebprotocol/drpc) endpoint with methods for mirroring, unmirror, and listing mirroed dDatabase-based data structures.

Currently it supports mirroring dDrives and individual DDatabases. It doesn't do data-structure detection by looking at DDatabase headers -- you gotta explicitly provide the type.

As of now, dDrive mirroring doesn't handle mounts. Maybe one day

## API

#### `await client.mirror(key, type)`
Start mirroring a dDatabase-based data structure.

This command will currently special-case the `ddrive` type, mirroring both metadata and content feeds.

#### `await client.unmirror(key, type)`
Stop mirroring a dDatabase-based data structure.

This command will currently special-case the `ddrive` type, unmirroring both metadata and content feeds.

#### `await client.status(key, type)`
Check if a data structure is being mirrored;

Returns an object of the form:
```js
{
  key, // Buffer
  type, // string
  mirroring // bool
}
```

#### `await client.list()`
List all data structures being mirrored.

Returns an Array of status objects with the same shape as the `status` return value.

#### `await client.stop()`
Shut down the server.

## License
MIT
