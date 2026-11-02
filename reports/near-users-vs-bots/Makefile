IMAGE   ?= rs-repro:demo
KEY     ?= $(HOME)/.config/gcloud/application_default_credentials.json
PROJECT ?= triple-router-448011-f7
PACK     = -v $(PWD):/pack -e REPRO_ROOT=/pack

.PHONY: check verify-cached verify numbers

check:          ## safeguards check every query
	docker run --rm $(PACK) $(IMAGE) check
verify-cached:  ## re-hash shipped results (no GCP)
	docker run --rm $(PACK) $(IMAGE) verify-cached
verify:         ## re-run every query on BigQuery, compare hashes
	docker run --rm -e BQ_PROJECT=$(PROJECT) -v $(KEY):/secrets/gcp.json:ro $(PACK) $(IMAGE) verify
numbers:        ## every number in REPORT.md must trace to results
	python3 -I ../../tools/check_numbers.py .
