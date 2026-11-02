IMAGE   ?= rs-repro:demo
# Any Google credential JSON works: a service-account key, or the user login
# created by `gcloud auth application-default login` (the default below).
KEY     ?= $(HOME)/.config/gcloud/application_default_credentials.json
# Billing project for live queries: set BQ_PROJECT in your shell, or pass PROJECT=<id>
PROJECT ?= $(BQ_PROJECT)
DOCKER_RUN = docker run --rm -e BQ_PROJECT=$(PROJECT) -v $(KEY):/secrets/gcp.json:ro

.PHONY: build check run verify verify-cached charts notebook

build:            ## build the image
	mkdir -p results && { test -s manifest.json || echo "{}" > manifest.json; } && docker build -t $(IMAGE) .

check: build      ## static guard check of every query (no GCP)
	docker run --rm $(IMAGE) check

run: build        ## produce results + manifest (writes back to ./results, ./manifest.json)
	$(DOCKER_RUN) -v $(PWD)/results:/work/results -v $(PWD)/manifest.json:/work/manifest.json $(IMAGE) run

verify: build     ## re-run queries live, compare to manifest
	$(DOCKER_RUN) $(IMAGE) verify

verify-cached: build  ## re-hash shipped results, no GCP needed
	docker run --rm $(IMAGE) verify-cached

charts: build
	docker run --rm -v $(PWD)/charts:/work/charts $(IMAGE) charts

# PACK=<report dir> opens that report pack; default is this repo's demo pack.
PACK ?= $(PWD)
notebook: build   ## JupyterLab on http://localhost:8888 (localhost only, no token)
	$(DOCKER_RUN) -p 127.0.0.1:8888:8888 -v $(PACK):/pack -e REPRO_ROOT=/pack --entrypoint jupyter $(IMAGE) \
	  lab --ip 0.0.0.0 --allow-root --no-browser --ServerApp.token='' --ServerApp.password='' --notebook-dir=/pack
