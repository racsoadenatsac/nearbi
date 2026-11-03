# rs-thesis: NEAR Intents vs NEAR price as leading indicators of real network usage.
# Everything runs inside the pinned rs-repro image; Python is not needed on the host.
IMAGE    ?= rs-repro:0.3.3
KEY      ?= $(HOME)/.config/gcloud/application_default_credentials.json
# Billing project for live queries: set BQ_PROJECT in your shell, or pass PROJECT=<id>
PROJECT  ?= $(BQ_PROJECT)
STAGE_DS ?= rs_thesis_stage
BUDGET   ?= 8
TOOLS    ?= $(abspath ../rs-reports/tools)
# q1 reads the 60 GB relayed-user stage table once; cap per aggregate query at 80 GB
PACK      = -v $(PWD):/pack -e REPRO_ROOT=/pack -e MAX_USD_TOTAL=$(BUDGET) -e MAX_GB_PER_QUERY=80
GCP       = -e BQ_PROJECT=$(PROJECT) -e BQ_STAGE_DATASET=$(STAGE_DS) -v $(KEY):/secrets/gcp.json:ro
PY        = docker run --rm $(PACK) -w /pack --entrypoint python $(IMAGE)

.PHONY: all image check stage run fetch analyze charts dashboard costs numbers verify verify-cached test

all: check stage run fetch analyze charts dashboard costs numbers  ## rebuild everything from raw data (live, billed)

image:          ## build the pinned rs-repro image from ../rs-repro at its tag
	cd ../rs-repro && git checkout -q v0.3.3 && docker build -q -t $(IMAGE) . ; git checkout -q main
check:          ## guard: fixed date windows, read-only queries, stage targets, fetch specs
	docker run --rm $(PACK) $(IMAGE) check
stage:          ## HEAVY raw scans, run once -> small tables in $(PROJECT).$(STAGE_DS)
	docker run --rm $(PACK) $(GCP) $(IMAGE) stage
run:            ## weekly aggregates from the stage tables -> results/*.csv (cheap)
	docker run --rm $(PACK) $(GCP) $(IMAGE) run
fetch:          ## NEAR/USDT weekly klines (Binance public API, CoinGecko fallback) -> raw/
	docker run --rm $(PACK) $(IMAGE) fetch
analyze:        ## growth rates, lead/lag correlations, out-of-sample test -> results/a_*.csv
	docker run --rm $(PACK) $(IMAGE) analyze
charts:         ## charts/*.png in the house style
	docker run --rm $(PACK) $(IMAGE) charts
dashboard:      ## dashboard/index.html
	$(PY) dashboard/build.py
costs:          ## COSTS.md from the cost ledger (costs.jsonl)
	$(PY) tools/costs_md.py
numbers:        ## every number in THESIS.md must trace to results/*.csv
	docker run --rm $(PACK) -v $(TOOLS):/tools:ro -w /pack --entrypoint python $(IMAGE) /tools/check_numbers.py /pack THESIS.md
verify-cached:  ## offline: re-hash results/ + raw/, re-run analysis.py, compare with manifest.json
	docker run --rm $(PACK) $(IMAGE) verify-cached
verify:         ## live: re-run the aggregate queries on the stage tables and re-fetch prices
	docker run --rm $(PACK) $(GCP) $(IMAGE) verify
