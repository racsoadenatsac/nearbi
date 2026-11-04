# rs-agent: `make demo` runs the whole shop loop on NEAR testnet (< 2 min); `make test` is offline.
.PHONY: demo demo-record demo-setup test test-ddb-local

demo:
	bin/demo

demo-record:  ## same, transcript saved to docs/demo-run-<UTC>.txt
	mkdir -p docs && bin/demo --transcript docs/demo-run-$$(date -u +%Y%m%dT%H%MZ).txt

demo-setup:   ## once: create + fund the testnet demo customer
	bin/demo-setup

test-ddb-local:  ## the DynamoDB order source against DynamoDB Local (Docker)
	bin/test-dynamo-local.sh

test:
	python3 -m unittest discover -s tests
