# Public loopback test certificates

These self-signed certificates and private keys are deliberately public test
fixtures. They protect no real account, service, or production endpoint.

`localhost` is trusted only by the isolated tests (or the native smoke launcher's
`NODE_EXTRA_CA_CERTS` environment). `wrong` exercises certificate rejection on
control and data connections. Application verification remains enabled.

Certificates expire October 10, 2036. Do not use these keys outside tests.
