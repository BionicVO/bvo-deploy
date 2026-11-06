param([string]$NotificationChannel)
$ErrorActionPreference = 'Stop'
$project = 'glass-marker-487618-i6'
$base = "https://monitoring.googleapis.com/v3/projects/$project"
$headers = @{ Authorization = 'Bearer ' + (gcloud.cmd auth print-access-token) }
$run = 'resource.type="cloud_run_revision" AND (resource.labels.service_name="bvo-frontend-prod" OR resource.labels.service_name="bvo-backend-prod")'
$sql = 'resource.type="cloudsql_database" AND resource.labels.database_id="glass-marker-487618-i6:bionic-postgres-prod"'
$widgets = @()
$existing = (Invoke-RestMethod -Uri "$base/alertPolicies" -Headers $headers).alertPolicies
function Publish($collection, $body) {
    Invoke-RestMethod -Method Post -Headers $headers -Uri "$base/$collection" -ContentType application/json -Body ($body | ConvertTo-Json -Depth 24)
}
# Each tuple defines a chart and its incident threshold. Use per-revision grouping
# for Cloud Run so a retiring revision cannot hide saturation on the serving one.
$signals = @(
    @('Instance count', $run, 'run.googleapis.com/container/instance_count', 'ALIGN_MAX', 'REDUCE_SUM', 8, '180s'),
    @('Request p95 (ms)', $run, 'run.googleapis.com/request_latencies', 'ALIGN_PERCENTILE_95', 'REDUCE_MAX', 2000, '300s'),
    @('5xx requests per minute', ($run + ' AND metric.labels.response_code_class="5xx"'), 'run.googleapis.com/request_count', 'ALIGN_SUM', 'REDUCE_SUM', 0, '0s'),
    @('Memory p95', $run, 'run.googleapis.com/container/memory/utilizations', 'ALIGN_PERCENTILE_95', 'REDUCE_MAX', 0.85, '180s'),
    @('CPU p95', $run, 'run.googleapis.com/container/cpu/utilizations', 'ALIGN_PERCENTILE_95', 'REDUCE_MAX', 0.85, '300s'),
    @('Database connections', $sql, 'cloudsql.googleapis.com/database/postgresql/num_backends', 'ALIGN_MAX', 'REDUCE_SUM', 60, '180s'),
    @('Database CPU', $sql, 'cloudsql.googleapis.com/database/cpu/utilization', 'ALIGN_MEAN', 'REDUCE_MAX', 0.8, '300s')
)
foreach ($signal in $signals) {
    $label,$scope,$metric,$align,$reduce,$threshold,$duration = $signal
    $filter = 'metric.type="' + $metric + '" AND ' + $scope
    $aggregation = @{ alignmentPeriod='60s'; perSeriesAligner=$align; crossSeriesReducer=$reduce }
    if ($scope.StartsWith($run)) { $aggregation.groupByFields = @('resource.label.revision_name') }
    $query = @{ filter=$filter; aggregation=$aggregation }
    $widgets += @{ title=$label; xyChart=@{ dataSets=@(@{ timeSeriesQuery=@{timeSeriesFilter=$query}; plotType='LINE' }) } }
    $name = "BVO production - $label"
    $policy = $existing | Where-Object displayName -eq $name
    if (!$policy) {
        $condition = @{ filter=$filter; aggregations=@($aggregation); comparison='COMPARISON_GT'; thresholdValue=$threshold; duration=$duration }
        $body = @{ displayName=$name; combiner='OR'; conditions=@(@{displayName=$label; conditionThreshold=$condition}); enabled=$true }
        if ($NotificationChannel) { $body.notificationChannels = @($NotificationChannel) }
        (Publish 'alertPolicies' $body).name
    } elseif ($NotificationChannel -and $NotificationChannel -notin $policy.notificationChannels) {
        $channels = @(@($policy.notificationChannels | Where-Object {$_}) + $NotificationChannel)
        $body = @{ notificationChannels=$channels } | ConvertTo-Json
        (Invoke-RestMethod -Method Patch -Headers $headers -Uri ("https://monitoring.googleapis.com/v3/"+$policy.name+'?updateMask=notification_channels') -ContentType application/json -Body $body).name
    }
}
$title = 'BionicVO production capacity'
$base = "https://monitoring.googleapis.com/v1/projects/$project"
if (!((Invoke-RestMethod -Uri "$base/dashboards" -Headers $headers).dashboards | Where-Object displayName -eq $title)) {
    (Publish 'dashboards' @{ displayName=$title; gridLayout=@{ columns='2'; widgets=$widgets } }).name
}
