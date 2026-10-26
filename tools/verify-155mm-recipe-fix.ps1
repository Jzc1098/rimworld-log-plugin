# Validate the two "add the 155mm Anti recipe" mods, and the DMS Antigrain one, without launching
# the game.
#
# Checks: XML legality, layout, manifest identity, that the new recipe's parent / product /
# ingredients / research all exist, that the recipe is not already defined by the target mod, and
# that both copies of the new recipe are byte-equivalent in the fields that matter.
#
# ASCII only in this file; non-ASCII paths arrive as parameters (Windows PowerShell 5.1 reads a .ps1
# as the ANSI codepage).
param(
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [Parameter(Mandatory = $true)][string]$Ce155File,
  [Parameter(Mandatory = $true)][string]$FortFile,
  [Parameter(Mandatory = $true)][string]$CeMortarFile,
  [Parameter(Mandatory = $true)][string]$CeBasesFile,
  [Parameter(Mandatory = $true)][string]$CeDefsDir,
  [Parameter(Mandatory = $true)][string]$BaseGameData
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Xml
$problems = 0
function Ok($m)  { Write-Host ('  ok   ' + $m) }
function Bad($m) { Write-Host ('  FAIL ' + $m); $script:problems++ }

$ceMod  = Join-Path $WorkDir 'fix-ce-155mm-anti'
$ftMod  = Join-Path $WorkDir 'fix-fortress-155mm-anti'
$dmsMod = Join-Path $WorkDir 'fix-dms-antigrain-recipe'

function Check-Manifest([string]$modDir, [string]$expectedId) {
  $about = Join-Path $modDir 'About\About.xml'
  $op    = Get-ChildItem -LiteralPath (Join-Path $modDir 'Patches') -File -Filter '*.xml' | Select-Object -First 1
  if (-not (Test-Path $about)) { Bad "missing About.xml in $modDir"; return }
  try { [xml]$a = Get-Content -LiteralPath $about -Raw -Encoding UTF8; Ok 'About.xml parses' } catch { Bad "About.xml :: $($_.Exception.Message)"; return }
  try { [xml]$null = Get-Content -LiteralPath $op.FullName -Raw -Encoding UTF8; Ok ("{0} parses" -f $op.Name) } catch { Bad "$($op.Name) :: $($_.Exception.Message)" }
  if (Test-Path (Join-Path $modDir 'Defs')) { Bad 'has a Defs folder; operations must live in Patches/' } else { Ok 'no Defs folder' }
  if ($a.ModMetaData.packageId -eq $expectedId) { Ok ("packageId {0}" -f $expectedId) } else { Bad ("packageId is {0}, expected {1}" -f $a.ModMetaData.packageId, $expectedId) }
  return ,@{ About = $a; Op = $op.FullName }
}

function Get-ResearchExists([string]$name) {
  $hit = Get-ChildItem -LiteralPath $CeDefsDir -Recurse -File -Filter '*.xml' -ErrorAction SilentlyContinue |
    Select-String -Pattern ("<defName>{0}</defName>" -f $name) -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { return 'CE' }
  $hit = Get-ChildItem -LiteralPath $BaseGameData -Recurse -File -Filter '*.xml' -ErrorAction SilentlyContinue |
    Select-String -Pattern ("<defName>{0}</defName>" -f $name) -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { return 'base' }
  return $null
}

# ------------------------------------------------------------------ CE mod
Write-Host '=============== fix-ce-155mm-anti ==============='
$ce = Check-Manifest $ceMod 'rimcrow.fix.ce.155mmanti'
[xml]$cePatch = Get-Content -LiteralPath $ce.Op -Raw -Encoding UTF8
$ceOps = @($cePatch.Patch.ChildNodes | Where-Object { $_.Name -eq 'Operation' })
if ($ceOps.Count -eq 1) { Ok 'one operation' } else { Bad ("$($ceOps.Count) operations") }
$newRec = $ceOps[0].value.RecipeDef
Write-Host ("  adds: {0}  parent={1}" -f $newRec.defName, $newRec.ParentName)
if ($newRec.defName -eq 'MakeAmmo_155mmHowitzerShell_Anti') { Ok 'defName matches what CE asks for' } else { Bad ("defName is {0}" -f $newRec.defName) }

# CE must not already define it
$ceTxt = Get-Content -LiteralPath $Ce155File -Raw -Encoding UTF8
if ($ceTxt.Contains('<defName>MakeAmmo_155mmHowitzerShell_Anti</defName>')) { Bad 'CE already defines this recipe' } else { Ok 'CE does not define it, so adding is safe' }
# the three sets that list the shell must still exist (we are no longer removing anything)
foreach ($s in @('AmmoSet_155mmHowitzerShell', 'AmmoSet_FT_155mmHowitzerShell', 'AmmoSet_FT_155mmHowitzerShell_directfire')) {
  $where = if ($s -like '*FT_*') { $FortFile } else { $Ce155File }
  if ((Get-Content -LiteralPath $where -Raw -Encoding UTF8).Contains("<defName>$s</defName>")) { Ok ("ammo set still present: $s") } else { Bad ("ammo set missing: $s") }
}

# ------------------------------------------------------------------ Fortifications mod
Write-Host ''
Write-Host '=============== fix-fortress-155mm-anti ==============='
$ft = Check-Manifest $ftMod 'rimcrow.fix.fortress.155mmanti'
[xml]$ftPatch = Get-Content -LiteralPath $ft.Op -Raw -Encoding UTF8
$ftOps = @($ftPatch.Patch.ChildNodes | Where-Object { $_.Name -eq 'Operation' })
if ($ftOps.Count -eq 1) { Ok 'one operation' } else { Bad ("$($ftOps.Count) operations") }
if ($ftOps[0].Class -eq 'PatchOperationConditional') { Ok 'operation is a Conditional (idempotence guard)' } else { Bad ("class is {0}" -f $ftOps[0].Class) }
$guard = $ftOps[0].xpath
Write-Host ("  guard xpath: {0}" -f $guard)
if ($ftOps[0].nomatch -and $ftOps[0].nomatch.Class -eq 'PatchOperationAdd') { Ok 'nomatch branch adds the recipe' } else { Bad 'nomatch branch missing or wrong class' }
$ftRec = $ftOps[0].nomatch.value.RecipeDef
if ($ftRec.defName -eq $newRec.defName) { Ok 'declares the same recipe defName as the CE mod' } else { Bad 'recipe defName differs between the two mods' }

# the two copies must agree on parent, product and research, or the outcome depends on load order
$diffs = @()
if ($ftRec.ParentName -ne $newRec.ParentName) { $diffs += "ParentName ($($ftRec.ParentName) vs $($newRec.ParentName))" }
$ftProd = @($ftRec.products.ChildNodes | Where-Object { $_.Name -ne '#comment' })[0]
$ceProd = @($newRec.products.ChildNodes | Where-Object { $_.Name -ne '#comment' })[0]
if ($ftProd.Name -ne $ceProd.Name) { $diffs += "product ($($ftProd.Name) vs $($ceProd.Name))" }
if ($ftProd.InnerText -ne $ceProd.InnerText) { $diffs += "product count ($($ftProd.InnerText) vs $($ceProd.InnerText))" }
$ftRes = @($ftRec.researchPrerequisites.li) -join ','
$ceRes = @($newRec.researchPrerequisites.li) -join ','
if ($ftRes -ne $ceRes) { $diffs += "research ($ftRes vs $ceRes)" }
if ($ftRec.workAmount -ne $newRec.workAmount) { $diffs += "workAmount ($($ftRec.workAmount) vs $($newRec.workAmount))" }
$ftIng = (@($ftRec.ingredients.li) | ForEach-Object { $_.filter.thingDefs.li + 'x' + $_.count }) -join ','
$ceIng = (@($newRec.ingredients.li) | ForEach-Object { $_.filter.thingDefs.li + 'x' + $_.count }) -join ','
if ($ftIng -ne $ceIng) { $diffs += "ingredients ($ftIng vs $ceIng)" }
if ($diffs.Count -eq 0) { Ok 'both copies are identical in every field that matters, so load order cannot change the result' }
else { foreach ($d in $diffs) { Bad "copies differ: $d" } }

# the guard target must not exist yet in the Fortifications file (no recipes there at all)
if ((Get-Content -LiteralPath $FortFile -Raw -Encoding UTF8).Contains('<RecipeDef')) { Write-Host '  info Fortifications file already has recipes; the guard will decide' }
else { Ok 'Fortifications file has no recipes, so the guard will add exactly one' }

# ------------------------------------------------------------------ shared reference checks
Write-Host ''
Write-Host '=== references used by the new recipe ==='
$x = New-Object System.Xml.XmlDocument
$x.Load($CeBasesFile)
$nav = $x.CreateNavigator()
$it = $nav.Select(('Defs/RecipeDef[@Name="{0}"]' -f $newRec.ParentName))
$n = 0; while ($it.MoveNext()) { $n++ }
if ($n -eq 1) { Ok ("parent {0} exists" -f $newRec.ParentName) } else { Bad ("parent {0} resolves to {1}" -f $newRec.ParentName, $n) }

$mortarTxt = Get-Content -LiteralPath $CeMortarFile -Raw -Encoding UTF8
if ($mortarTxt.Contains('<defName>Ammo_155mmHowitzerShell_Anti</defName>') -or (Get-Content -LiteralPath $Ce155File -Raw -Encoding UTF8).Contains('<defName>Ammo_155mmHowitzerShell_Anti</defName>')) {
  Ok 'product Ammo_155mmHowitzerShell_Anti exists in CE'
} else { Bad 'product not found' }

foreach ($ing in $newRec.ingredients.li) {
  $def = $ing.filter.thingDefs.li
  $r = Get-ResearchExists $def
  if ($r) { Ok ("ingredient $def exists ($r)") } else { Bad ("ingredient $def not found") }
}
foreach ($r in $newRec.researchPrerequisites.li) {
  $w = Get-ResearchExists $r
  if ($w) { Ok ("research $r exists ($w)") } else { Bad ("research $r not found") }
}

# ------------------------------------------------------------------ DMS mod untouched by this round
Write-Host ''
Write-Host '=============== fix-dms-antigrain-recipe (already verified previously) ==============='
$about = Join-Path $dmsMod 'About\About.xml'
if (Test-Path $about) {
  try { [xml]$d = Get-Content -LiteralPath $about -Raw -Encoding UTF8; Ok ("packageId {0}" -f $d.ModMetaData.packageId) } catch { Bad "About.xml :: $($_.Exception.Message)" }
} else { Bad 'missing' }

# ------------------------------------------------------------------ no stale removal patch left
Write-Host ''
Write-Host '=== no leftover file from the removal approach ==='
foreach ($p in @("$ceMod\Patches\RemoveAntiFromAmmoSet.xml", "$ftMod\Patches\RemoveAntiFromAmmoSets.xml")) {
  if (Test-Path $p) { Bad ("leftover: {0}" -f (Split-Path -Leaf $p)) } else { Ok ("absent: {0}" -f (Split-Path -Leaf $p)) }
}

Write-Host ''
if ($problems -eq 0) { Write-Host 'ALL CHECKS PASSED' } else { Write-Host ("{0} PROBLEM(S)" -f $problems); exit 1 }
