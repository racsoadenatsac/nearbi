FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg \
    REPRO_ROOT=/work \
    GOOGLE_APPLICATION_CREDENTIALS=/secrets/gcp.json

WORKDIR /work
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Code, queries and the published manifest/results are part of the image so a
# report's pack is self-contained. Credentials are NEVER copied in; mount them:
#   -v /path/key.json:/secrets/gcp.json:ro
COPY repro/ /work/repro/
COPY queries/ /work/queries/
COPY notebooks/ /work/notebooks/
COPY manifest.json* /work/
COPY results/ /work/results/

ENTRYPOINT ["python", "/work/repro/run.py"]
CMD ["help"]
