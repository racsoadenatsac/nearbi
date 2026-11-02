IMAGE   ?= rs-repro:demo
KEY     ?= $(HOME)/.config/gcloud/application_default_credentials.json
PROJECT ?= triple-router-448011-f7
PACK     = -v $(PWD):/pack -e REPRO_ROOT=/pack

.PHONY: check verify-cached verify numbers charts notebook notebook-html

check:          ## safeguards check every query
	docker run --rm $(PACK) $(IMAGE) check
verify-cached:  ## re-hash shipped results (no GCP)
	docker run --rm $(PACK) $(IMAGE) verify-cached
verify:         ## re-run every query on BigQuery, compare hashes
	docker run --rm -e BQ_PROJECT=$(PROJECT) -v $(KEY):/secrets/gcp.json:ro $(PACK) $(IMAGE) verify
charts:         ## rebuild charts/*.png from results
	docker run --rm $(PACK) $(IMAGE) charts
notebook:       ## JupyterLab on http://localhost:8888 (localhost only); live cell uses your gcloud login
	docker run --rm -p 127.0.0.1:8888:8888 -e BQ_PROJECT=$(PROJECT) -v $(KEY):/secrets/gcp.json:ro $(PACK) \
	  --entrypoint jupyter $(IMAGE) lab --ip 0.0.0.0 --allow-root --no-browser \
	  --ServerApp.token='' --ServerApp.password='' --notebook-dir=/pack
notebook-html:  ## execute the notebook headless and save notebook.html
	docker run --rm $(PACK) -w /pack --entrypoint jupyter $(IMAGE) nbconvert --to html --execute notebook.ipynb --output notebook.html
numbers:        ## every number in REPORT.md must trace to results
	python3 -I ../../tools/check_numbers.py .
