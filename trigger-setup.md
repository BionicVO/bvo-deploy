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

### 0.4 Set up the private-connectivity plumbing

Cloud SQL and Memorystore both need private networking set up before you
can create the instances themselves. **Use the project's existing `default`
network rather than creating a separate `bvo-vpc`** — every GCP project
already has one, and there's no benefit to a second network here. (Earlier
drafts of this doc referenced a `bvo-vpc` that was never actually created;
if you already have Cloud SQL instances with a private IP on some other
network, use that network's name instead of `default` throughout.)

```
# reserve an IP range for Cloud SQL's private connection (Private Services Access):
gcloud compute addresses create bvo-psa-range \
  --global --purpose=VPC_PEERING --prefix-length=16 --network=default

gcloud services vpc-peerings connect \
  --service=servicenetworking.googleapis.com \
  --ranges=bvo-psa-range --network=default

# Serverless VPC Access connector — this is what lets Cloud Run reach into the VPC:
gcloud compute networks vpc-access connectors create bvo-vpc-connector \
  --region=us-central1 --network=default --range=10.8.0.0/28
```

### 0.5 Create the Cloud SQL (PostgreSQL) instances — one per environment

```
for ENV in staging prod; do
  gcloud sql instances create "bvo-db-$ENV" \
    --database-version=POSTGRES_16 \
    --tier=db-custom-1-3840 \
    --region=us-central1 \
    --network=projects/PROJECT_ID/global/networks/default \
    --no-assign-ip

  gcloud sql databases create bvo_db --instance="bvo-db-$ENV"
  gcloud sql users create bvo_app --instance="bvo-db-$ENV" --password="CHANGE_ME_$ENV"
done
```

**Actual instance names in this project don't match the placeholders above** —
they were created via the console before this script ran, and Cloud SQL
instances can't be renamed after creation (only cloned into a new
differently-named instance, which isn't worth the cost/complexity here since
the instance name never appears anywhere in the app config anyway — only its
private IP, via the secrets below, does). Substitute your real names
everywhere you see `bvo-db-staging` / `bvo-db-prod` in this doc and in
`cloudbuild-backend.yaml` / `promote-to-prod.yaml`'s comments:

| Environment | Actual instance name    |
|-------------|--------------------------|
| staging     | `bionicvo-postgres`     |
| prod        | `bionic-postgres-prod`  |

Grab each instance's private IP (`gcloud sql instances describe bionicvo-postgres
--format='value(ipAddresses)'` — after adding a private IP per the networking
fix already applied, this returns both the public and private address; use
the one with `type: PRIVATE`) — you'll store it as a secret in step 0.7.

### 0.6 Create the Memorystore for Valkey instances — one per environment

Valkey uses Private Service Connect rather than the older peering model, so
the exact flags are worth double-checking against the current docs page
linked below before you run this — but the shape is:

```
for ENV in staging prod; do
  gcloud memorystore instances create "bvo-valkey-$ENV" \
    --project=PROJECT_ID --location=us-central1 \
    --node-type=SHARED_CORE_NANO --shard-count=1 --replica-count=0 \
    --endpoints='[{"connections":[{"pscAutoConnection":{"network":"projects/PROJECT_ID/global/networks/default","projectId":"PROJECT_ID"}}]}]'
done
```

### 0.7 Create the Artifact Registry repo

```
gcloud artifacts repositories create bvo-images \
  --repository-format=docker --location=us-central1
```

### 0.8 Create the Secret Manager entries

One set per environment — names must match what's already in
`backend-service.staging.yaml` / `backend-service.prod.yaml`. Note: Stripe
is intentionally *not* in this list — Stripe key handling is managed inside
the app itself, not via Secret Manager/Cloud Run env vars.

```
for ENV in staging prod; do
  for NAME in db-host db-port db-username db-password db-name redis-url; do
    gcloud secrets create "bvo-$NAME-$ENV" --replication-policy=automatic
  done
done

# then add the actual values, e.g.:
printf '10.x.x.x' | gcloud secrets versions add bvo-db-host-staging --data-file=-
printf 'CHANGE_ME_staging' | gcloud secrets versions add bvo-db-password-staging --data-file=-
# ...repeat for each secret with its real value (staging DB private IP, prod
# DB private IP, staging/prod Valkey discovery endpoint as redis://HOST:PORT)
```

**`DB_SSL` is a plain env var, not a secret.** `bvo-api`'s datasource config
(`ssl: DATABASE_CONFIG.SSL === "true" ? {rejectUnauthorized: false} : false`)
requires the exact string `"true"` to enable SSL — without it, Cloud SQL's
`pg_hba.conf` rejects the connection with `no encryption`, since these
instances enforce `sslMode: ENCRYPTED_ONLY`. It's set via `--set-env-vars`
on the migration Cloud Run Jobs (`cloudbuild-backend.yaml`,
`promote-to-prod.yaml`) and as a plain `env` entry (not `secretKeyRef`) in
both `backend-service.*.yaml` manifests.

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

### 0.10 Create a custom Cloud Build service account and grant IAM roles

2nd-gen triggers (the kind Section 2 creates) require an explicit
`--service-account=` — but that service account must be **user-managed**;
explicitly referencing the legacy default `PROJECT_NUMBER@cloudbuild.gserviceaccount.com`
is rejected at build-run time with `invalid value for build.service_account`,
even though trigger *creation* accepts it. So: create a real SA instead of
reusing the default one.

```
PROJECT_NUMBER=$(gcloud projects describe bvo-app --format='value(projectNumber)')
CB_RUNNER="bvo-cloudbuild-runner@bvo-app.iam.gserviceaccount.com"

# 1. create the custom SA
gcloud iam service-accounts create bvo-cloudbuild-runner \
  --display-name="BionicVO Cloud Build runner"

# 2. let Cloud Build's control plane act as this SA
gcloud iam service-accounts add-iam-policy-binding "${CB_RUNNER}" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-cloudbuild.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"

# 3. grant the SA everything it needs to actually run the build steps in
#    cloudbuild-*.yaml and promote-to-prod.yaml
for ROLE in logging.logWriter cloudbuild.builds.builder run.admin \
            clouddeploy.releaser artifactregistry.writer secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding bvo-app \
    --member="serviceAccount:${CB_RUNNER}" --role="roles/${ROLE}"
done

# whoever will approve prod rollouts (can be yourself):
gcloud projects add-iam-policy-binding bvo-app --member="user:YOUR_EMAIL" --role=roles/clouddeploy.approver
```

Reference this SA as `projects/PROJECT_ID/serviceAccounts/bvo-cloudbuild-runner@PROJECT_ID.iam.gserviceaccount.com`
in every `--service-account=` flag in Section 2 — don't use the
`PROJECT_NUMBER@cloudbuild.gserviceaccount.com` default account there.

### 0.11 Grant the migration Cloud Run Jobs' runtime identity access to secrets

`run-staging-migrations` and `run-prod-migrations` (in `cloudbuild-backend.yaml`
and `promote-to-prod.yaml`) run database migrations as **Cloud Run Jobs**
(`bvo-migrate-staging` / `bvo-migrate-prod`), not a raw `docker run` step —
a plain Cloud Build step (and even a Cloud Build private pool) can't reach
Cloud SQL's private IP, because VPC peering isn't transitive: the pool's
peering to `default` and Cloud SQL's own peering to `default` don't chain
into a route between them. The Serverless VPC Access connector doesn't have
that problem — its instances live directly inside `default`'s subnet — so
migrations run as a Cloud Run Job using that same connector, identical to
how the deployed backend service already reaches Cloud SQL and Memorystore.

`bvo-cloudbuild-runner`'s `run.admin` role (granted above) is enough to
deploy and execute these jobs. But two more identity links are needed, or
`gcloud run jobs deploy` fails before the job is even created:

**1. `bvo-cloudbuild-runner` needs permission to launch something that runs
*as* another service account.** Jobs use the default Compute Engine service
account unless you pass `--service-account=` to `gcloud run jobs deploy`,
and deploying a resource that runs under a different identity always
requires `iam.serviceAccounts.actAs` on that target identity — granted via
`roles/iam.serviceAccountUser`, on the *service account*, not the project:

```
gcloud iam service-accounts add-iam-policy-binding "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --member="serviceAccount:${CB_RUNNER}" \
  --role="roles/iam.serviceAccountUser"
```

**2. The job's own runtime identity** — separate from Cloud Build's — is
what actually reads the `--set-secrets` values at execution time, and needs
`secretmanager.secretAccessor` in its own right:

```
gcloud projects add-iam-policy-binding bvo-app \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor
```

The deployed backend **service** (`backend-service.staging.yaml` /
`backend-service.prod.yaml`) reads secrets the same way via `secretKeyRef`
and runs under the same default identity unless you specify otherwise, so
this one grant covers both the migration jobs and the running service.

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
which both build configs use to clone `bvo-deploy` mid-build.

Trigger branch is `staging`, not `main` — pushing/merging to `main` no
longer builds or deploys anything. Getting to prod is still the separate
manual step in Section 3.

**Four things that are easy to get wrong here, in order of how we actually
hit them:**

1. The console's "Connect repository" flow (Section 0.9) creates a
   **2nd-gen** repository connection, which needs the `gcloud beta` command
   group and a `--repository=` resource path — not GA `gcloud builds` and
   not the older `--repo-owner`/`--repo-name` flags (those are 1st-gen only
   and fail with `INVALID_ARGUMENT` against a 2nd-gen connection).
2. The repository resource `NAME` is prefixed with the connection name —
   connection `BionicVO` + repo `bvo-new` → resource name `BionicVO-bvo-new`,
   not just `bvo-new`. Look these up rather than guessing:
   ```
   gcloud builds connections list --region=REGION
   gcloud builds repositories list --connection=CONNECTION_NAME --region=REGION
   ```
3. **2nd-gen triggers require an explicit `--service-account=`** — omitting
   it fails at trigger *creation* with the same generic `INVALID_ARGUMENT`,
   no clearer than any other case of this error.
4. That service account must be **user-managed** — explicitly referencing
   the legacy default `PROJECT_NUMBER@cloudbuild.gserviceaccount.com` is
   accepted at trigger creation but rejected the moment a build actually
   runs (`invalid value for build.service_account`). Use the custom SA
   Section 0.10 creates (`bvo-cloudbuild-runner@PROJECT_ID.iam.gserviceaccount.com`),
   not the default one.

Putting it together:

```
gcloud beta builds triggers create github \
  --name=bvo-frontend-ci \
  --region=REGION \
  --repository=projects/PROJECT_ID/locations/REGION/connections/CONNECTION_NAME/repositories/CONNECTION_NAME-bvo-new \
  --branch-pattern="^staging$" \
  --build-config=cloudbuild-frontend.yaml \
  --service-account=projects/PROJECT_ID/serviceAccounts/bvo-cloudbuild-runner@PROJECT_ID.iam.gserviceaccount.com \
  --substitutions=_REGION=REGION,_REPO=bvo-images,_DELIVERY_PIPELINE=bvo-app-pipeline,_DEPLOY_REPO_URL=https://github.com/BionicVO/bvo-deploy.git

gcloud beta builds triggers create github \
  --name=bvo-backend-ci \
  --region=REGION \
  --repository=projects/PROJECT_ID/locations/REGION/connections/CONNECTION_NAME/repositories/CONNECTION_NAME-bvo-api \
  --branch-pattern="^staging$" \
  --build-config=cloudbuild-backend.yaml \
  --service-account=projects/PROJECT_ID/serviceAccounts/bvo-cloudbuild-runner@PROJECT_ID.iam.gserviceaccount.com \
  --substitutions=_REGION=REGION,_REPO=bvo-images,_DELIVERY_PIPELINE=bvo-app-pipeline,_DEPLOY_REPO_URL=https://github.com/BionicVO/bvo-deploy.git
```

For a branch change (or any other field) on an already-working trigger,
`update github` works in place:
```
gcloud beta builds triggers update github bvo-frontend-ci --region=REGION --branch-pattern="^staging$"
gcloud beta builds triggers update github bvo-backend-ci --region=REGION --branch-pattern="^staging$"
```

If you created a trigger with the legacy default service account (before
Section 0.10 above existed) and need to switch it to the custom SA, try
updating `--service-account=` in place first; if that field turns out to be
creation-only, delete and recreate the trigger with the `create` command
above instead:
```
gcloud beta builds triggers delete bvo-frontend-ci --region=REGION
```

## 3. Promote staging → prod

Every push to the `staging` branch auto-deploys to the `staging` Cloud Run
target (see the `create-release` step in each `cloudbuild-*.yaml`). Getting
the same release to `prod` is a two-step, human-gated process — nothing
reaches prod on a push alone:

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
