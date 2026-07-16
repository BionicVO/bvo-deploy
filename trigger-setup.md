# BionicVO CI/CD — one-time setup

Run once per environment (adjust `PROJECT_ID`, `REGION`, repo owner/name).

If this is your first time in GCP, do Section 0 first, in order — everything
after it (the `.yaml` files you already have) assumes these resources exist.

## Repo layout: three repos, not two

`bvo-new` and `bvo-api` are separate repos under
[github.com/BionicVO](https://github.com/BionicVO) — each owns its own
`cloudbuild-*.yaml` at its repo root (see the comment at the top of each
file). But `clouddeploy.yaml`, `skaffold.yaml`, the four
`*-service.{staging,prod}.yaml` manifests, and `promote-to-prod.yaml` don't
belong to either app — a release always pairs both images together, so this
config needs to live somewhere both builds can reach it.

Create a third repo, **`bvo-deploy`**, under the same GitHub org, and push
those five files there. Making it public is the simplest option (it holds
no secrets — actual values live in Secret Manager — only structure), since
both `cloudbuild-frontend.yaml` and `cloudbuild-backend.yaml` now `git
clone` it mid-build via a `_DEPLOY_REPO_URL` substitution. If you'd rather
keep it private, swap that clone step's URL for an authenticated one
(`https://TOKEN@github.com/...`) with the token stored in Secret Manager.

```
github.com/BionicVO/bvo-new/            (existing repo — frontend app)
├── src/...
└── cloudbuild-frontend.yaml

github.com/BionicVO/bvo-api/            (existing repo — backend app)
├── src/...
└── cloudbuild-backend.yaml

github.com/BionicVO/bvo-deploy/         (new repo — shared release config)
├── clouddeploy.yaml
├── skaffold.yaml
├── frontend-service.staging.yaml
├── frontend-service.prod.yaml
├── backend-service.staging.yaml
├── backend-service.prod.yaml
├── promote-to-prod.yaml
├── trigger-setup.md
└── secrets-list.txt
```

`trigger-setup.md` and `secrets-list.txt` are just reference docs — put
them in `bvo-deploy` too so anyone setting this up has one place to look.

## 0. First-time GCP project, tooling, and repo setup

### 0.1 Install and authenticate the CLI

Easiest path if you don't want to install anything locally: open **Cloud
Shell** from the GCP console (the `>_` icon top-right) — it's a browser
terminal with `gcloud` already installed and authenticated. Otherwise:

```
# install: https://cloud.google.com/sdk/docs/install
gcloud init
gcloud auth login
```

### 0.2 Create a project and attach billing

```
gcloud projects create bvo-app --name="BionicVO"
gcloud config set project bvo-app
gcloud config set run/region us-central1   # pick your region, use it everywhere below

# link a billing account (list yours first if you don't know the ID):
gcloud billing accounts list
gcloud billing projects link bvo-app --billing-account=BILLING_ACCOUNT_ID
```

This guide uses one project for both staging and prod (simpler to start
with — separate resource names per environment, as in the manifests you
already have). You can split into two projects later without changing the
pipeline shape, just the `run.location` values in `clouddeploy.yaml`.

### 0.3 Enable the APIs you'll need

```
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  clouddeploy.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  memorystore.googleapis.com \
  vpcaccess.googleapis.com \
  servicenetworking.googleapis.com \
  networkconnectivity.googleapis.com \
  compute.googleapis.com \
  iam.googleapis.com
```

### 0.4 Create a VPC and the private-connectivity plumbing

Cloud SQL and Memorystore both need private networking set up before you
can create the instances themselves.

```
gcloud compute networks create bvo-vpc --subnet-mode=auto

# reserve an IP range for Cloud SQL's private connection (Private Services Access):
gcloud compute addresses create bvo-psa-range \
  --global --purpose=VPC_PEERING --prefix-length=16 --network=bvo-vpc

gcloud services vpc-peerings connect \
  --service=servicenetworking.googleapis.com \
  --ranges=bvo-psa-range --network=bvo-vpc

# Serverless VPC Access connector — this is what lets Cloud Run reach into the VPC:
gcloud compute networks vpc-access connectors create bvo-vpc-connector \
  --region=us-central1 --network=bvo-vpc --range=10.8.0.0/28
```

### 0.5 Create the Cloud SQL (PostgreSQL) instances — one per environment

```
for ENV in staging prod; do
  gcloud sql instances create "bvo-db-$ENV" \
    --database-version=POSTGRES_16 \
    --tier=db-custom-1-3840 \
    --region=us-central1 \
    --network=projects/bvo-app/global/networks/bvo-vpc \
    --no-assign-ip

  gcloud sql databases create bvo_db --instance="bvo-db-$ENV"
  gcloud sql users create bvo_app --instance="bvo-db-$ENV" --password="CHANGE_ME_$ENV"
done
```

Grab each instance's private IP (`gcloud sql instances describe bvo-db-staging
--format='value(ipAddresses[0].ipAddress)'`) — you'll store it as a secret
in step 0.7.

### 0.6 Create the Memorystore for Valkey instances — one per environment

Valkey uses Private Service Connect rather than the older peering model, so
the exact flags are worth double-checking against the current docs page
linked below before you run this — but the shape is:

```
for ENV in staging prod; do
  gcloud memorystore instances create "bvo-valkey-$ENV" \
    --project=bvo-app --location=us-central1 \
    --node-type=SHARED_CORE_NANO --shard-count=1 --replica-count=0 \
    --endpoints='[{"connections":[{"pscAutoConnection":{"network":"projects/bvo-app/global/networks/bvo-vpc","projectId":"bvo-app"}}]}]'
done
```

### 0.7 Create the Artifact Registry repo

```
gcloud artifacts repositories create bvo-images \
  --repository-format=docker --location=us-central1
```

### 0.8 Create the Secret Manager entries

One set per environment — names must match what's already in
`backend-service.staging.yaml` / `backend-service.prod.yaml`:

```
for ENV in staging prod; do
  for NAME in db-host db-port db-username db-password db-name redis-url stripe-secret; do
    gcloud secrets create "bvo-$NAME-$ENV" --replication-policy=automatic
  done
done

# then add the actual values, e.g.:
printf '10.x.x.x' | gcloud secrets versions add bvo-db-host-staging --data-file=-
printf 'CHANGE_ME_staging' | gcloud secrets versions add bvo-db-password-staging --data-file=-
# ...repeat for each secret with its real value (staging DB IP, prod DB IP,
# staging/prod Valkey connection string, Stripe test key for staging, live key for prod)
```

### 0.9 Connect your GitHub repos to Cloud Build

This one step genuinely needs a browser, even if you do everything else
with `gcloud` — connecting a GitHub repo is an OAuth/GitHub-App install
that Google requires you complete in the console:

Cloud Build → **Repositories** → **Connect repository** → choose GitHub →
authorize the GitHub App on the `BionicVO` org → select **both** `bvo-new`
and `bvo-api` (these are the two repos that need Cloud Build triggers).
`bvo-deploy` doesn't need this step — it's only ever `git clone`d as a
build step, not triggered directly — unless you later want a trigger that
auto-runs `gcloud deploy apply` when `clouddeploy.yaml` changes.
Do this once; after that, trigger creation in Section 2 below is pure `gcloud`.

### 0.10 Grant IAM roles

```
PROJECT_NUMBER=$(gcloud projects describe bvo-app --format='value(projectNumber)')
CB_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

gcloud projects add-iam-policy-binding bvo-app --member="serviceAccount:${CB_SA}" --role=roles/run.admin
gcloud projects add-iam-policy-binding bvo-app --member="serviceAccount:${CB_SA}" --role=roles/clouddeploy.releaser
gcloud projects add-iam-policy-binding bvo-app --member="serviceAccount:${CB_SA}" --role=roles/artifactregistry.writer
gcloud projects add-iam-policy-binding bvo-app --member="serviceAccount:${CB_SA}" --role=roles/secretmanager.secretAccessor

# whoever will approve prod rollouts (can be yourself):
gcloud projects add-iam-policy-binding bvo-app --member="user:YOUR_EMAIL" --role=roles/clouddeploy.approver
```

Once Section 0 is done, continue with Sections 1–3 below using your actual
`bvo-app` project ID and `us-central1` region in place of `PROJECT_ID`/`REGION`.

## 1. Apply the Cloud Deploy pipeline

Run this from a checkout of `bvo-deploy` (or with `clouddeploy.yaml` copied
locally):

```
gcloud deploy apply --file=clouddeploy.yaml \
  --region=REGION --project=PROJECT_ID
```

`clouddeploy.yaml` still has literal `PROJECT_ID`/`REGION` placeholders inside
the `run.location` fields — replace those before applying, or `envsubst` the
file.

## 2. Create the two Cloud Build triggers

Since `bvo-new` and `bvo-api` are already separate repos, each trigger fires
on any push to that repo — no path filter needed (that was only relevant
for a shared monorepo). Note the added `_DEPLOY_REPO_URL` substitution,
which both build configs use to clone `bvo-deploy` mid-build:

```
gcloud builds triggers create github \
  --name=bvo-frontend-ci \
  --repo-owner=BionicVO --repo-name=bvo-new \
  --branch-pattern="^main$" \
  --build-config=cloudbuild-frontend.yaml \
  --substitutions=_REGION=REGION,_REPO=bvo-images,_DELIVERY_PIPELINE=bvo-app-pipeline,_DEPLOY_REPO_URL=https://github.com/BionicVO/bvo-deploy.git

gcloud builds triggers create github \
  --name=bvo-backend-ci \
  --repo-owner=BionicVO --repo-name=bvo-api \
  --branch-pattern="^main$" \
  --build-config=cloudbuild-backend.yaml \
  --substitutions=_REGION=REGION,_REPO=bvo-images,_DELIVERY_PIPELINE=bvo-app-pipeline,_DEPLOY_REPO_URL=https://github.com/BionicVO/bvo-deploy.git
```

## 3. Promote staging → prod

Every push to `main` auto-deploys to `staging` (see the `create-release`
step in each `cloudbuild-*.yaml`). Getting the same release to `prod` is a
two-step, human-gated process — nothing reaches prod on a push alone:

```
# 1. after verifying staging, migrate prod's DB and create the prod rollout
#    (promote-to-prod.yaml runs prod migrations against the SAME image that
#    was deployed to staging, then calls `releases promote`):
gcloud builds submit --no-source --config=promote-to-prod.yaml \
  --substitutions=_RELEASE=rel-<short-sha>,_REGION=REGION,_REPO=bvo-images,_DELIVERY_PIPELINE=bvo-app-pipeline

# 2. approve the pending prod rollout (or click Approve in the Cloud Deploy console):
gcloud deploy rollouts approve <rollout-id> \
  --release=rel-<short-sha> \
  --delivery-pipeline=bvo-app-pipeline \
  --region=REGION \
  --target=prod
```

Find `<rollout-id>` with:
```
gcloud deploy rollouts list --release=rel-<short-sha> \
  --delivery-pipeline=bvo-app-pipeline --region=REGION --target=prod
```

## 4. Notes

`frontend-service.yaml` / `backend-service.yaml` (the original single-environment
manifests) are superseded by the `.staging.yaml` / `.prod.yaml` versions and are
no longer referenced by `skaffold.yaml` — safe to ignore or delete locally.

All five deploy-related files (`clouddeploy.yaml`, `skaffold.yaml`, the four
service manifests, `promote-to-prod.yaml`) belong in `bvo-deploy`, not in
`bvo-new` or `bvo-api` — see "Repo layout" at the top of this file.
