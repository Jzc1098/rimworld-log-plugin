# Validate the three recipe-fix mods without launching the game.
#
# Checks per mod: XML legality, file layout, manifest identity, and that every xpath target really
# exists in the source mod's xml as assembled. Also verifies the referenced defNames and the new
# recipe's cross-references.
#
# ASCII only in this file, including inside string literals: Windows PowerShell 5.1 reads a .ps1 as
# the ANSI codepage, so a literal non-ASCII path in here would be mojibake. Every path that
# contains non-ASCII characters therefore arrives as a parameter.
param(
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [Parameter(Mandatory = $true)][string]$RatkinAmmoDir,
  [Parameter(Mandatory = $true)][string]$FortFile,
  [Parameter(Mandatory = $true)][string]$CeMortarFile,
  [Parameter(Mandatory = $true)][string]$CeBasesFile,
  [Parameter(Mandatory = $true)][string]$CeShell155File,
  [Parameter(Mandatory = $true)][string]$CeDll,
  [Parameter(Mandatory = $true)][string]$BaseGameData
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Xml
$problems = 0
function Ok($m)  { Write-Host ('  ok   ' + $m) }
function Bad($m) { Write-Host ('  FAIL ' + $m); $script:problems++ }

$ratkin   = $RatkinAmmoDir
$fort     = $FortFile
$ceMortar = $CeMortarFile
$ceBases  = $CeBasesFile
$baseData = $BaseGameData

function Test-Xpath([string]$file, [string]$xpath) {
  $doc = New-Object System.Xml.XmlDocument
  $doc.Load($file)
  $nav = $doc.CreateNavigator()
  try {
    $it = $nav.Select($xpath)
    $n = 0
    while ($it.MoveNext()) { $n++ }
    return $n
  } catch {
    return -1
  }
}

# ---------------------------------------------------------------- mod 1
Write-Host '================ MOD 1: fix-ratkin-recipe-names ================'
$m1 = Join-Path $WorkDir 'fix-ratkin-recipe-names'
foreach ($f in @("$m1\About\About.xml", "$m1\Patches\RenameRecipes.xml")) {
  if (-not (Test-Path $f)) { Bad "missing $f"; continue }
  try { [xml]$null = Get-Content -LiteralPath $f -Raw -Encoding UTF8; Ok (Split-Path -Leaf $f) }
  catch { Bad "$(Split-Path -Leaf $f) :: $($_.Exception.Message)" }
}
if (Test-Path "$m1\Defs") { Bad 'has a Defs folder; operations must not live there' } else { Ok 'no Defs folder' }

[xml]$r = Get-Content -LiteralPath "$m1\Patches\RenameRecipes.xml" -Raw -Encoding UTF8
[xml]$ra = Get-Content -LiteralPath "$m1\About\About.xml" -Raw -Encoding UTF8
Write-Host ("  packageId: {0}" -f $ra.ModMetaData.packageId)

# The old names must exist in Ratkin's files; the new names must not already exist.
$ratkinXml = Get-ChildItem -LiteralPath $ratkin -File -Filter '*.xml'
$renames = @(
  @{ old = 'MakeAmmo_RKDragonAmmo_Normal';  new = 'MakeAmmo_RK_DragonAmmo_Normal';  file = 'Ratkin_Dragon Strike.xml' },
  @{ old = 'MakeAmmo_RKDragonAmmo_Flame';   new = 'MakeAmmo_RK_DragonAmmo_Flame';   file = 'Ratkin_Dragon Strike.xml' }
)
foreach ($rn in $renames) {
  $src = Join-Path $ratkin $rn.file
  $t = Get-Content -LiteralPath $src -Raw -Encoding UTF8
  if ($t.Contains("<defName>$($rn.old)</defName>")) { Ok ("source has {0}" -f $rn.old) } else { Bad ("source lacks {0}" -f $rn.old) }
  # new name must be exactly the CE expectation: MakeAmmo_ + ammo defName minus the Ammo_ prefix
  $ammo = 'Ammo_' + $rn.new.Substring('MakeAmmo_'.Length)
  if ($t.Contains("<$ammo>")) { Ok ("  -> produces ammunition $ammo, and the new name matches it") }
  else { Bad ("  -> ammunition $ammo not found in $($rn.file)") }
  # guard: the new name must not already be taken
  $clash = $false
  foreach ($f in $ratkinXml) {
    $tt = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8
    if ($tt.Contains("<defName>$($rn.new)</defName>")) { $clash = $true }
  }
  if ($clash) { Bad ("  -> $($rn.new) already exists; renaming would duplicate it") } else { Ok ("  -> $($rn.new) is free") }
}
# every operation's xpath must resolve
foreach ($op in $r.Patch.Operation) {
  $target = ($op.xpath -replace '^Defs/RecipeDef\[defName="([^"]+)"\].*$', '$1')
  $file = ($renames | Where-Object { $_.old -eq $target } | Select-Object -First 1).file
  $n = Test-Xpath (Join-Path $ratkin $file) $op.xpath
  if ($n -ge 1) { Ok ("xpath resolves ({0} node) :: {1}" -f $n, $op.xpath) } else { Bad ("xpath does not resolve :: {0}" -f $op.xpath) }
}

# ---------------------------------------------------------------- mod 2
Write-Host ''
Write-Host '================ MOD 2: fix-fortress-155mm-anti ================'
Write-Host '  (reworked into an add-a-recipe mod; validated by verify-155mm-recipe-fix.ps1)'
Write-Host ''
Write-Host '================ MOD 3: fix-dms-antigrain-recipe ================'
$m3 = Join-Path $WorkDir 'fix-dms-antigrain-recipe'
foreach ($f in @("$m3\About\About.xml", "$m3\Patches\AddAntigrainRecipe.xml")) {
  if (-not (Test-Path $f)) { Bad "missing $f"; continue }
  try { [xml]$null = Get-Content -LiteralPath $f -Raw -Encoding UTF8; Ok (Split-Path -Leaf $f) }
  catch { Bad "$(Split-Path -Leaf $f) :: $($_.Exception.Message)" }
}
if (Test-Path "$m3\Defs") { Bad 'has a Defs folder' } else { Ok 'no Defs folder' }
[xml]$r3 = Get-Content -LiteralPath "$m3\Patches\AddAntigrainRecipe.xml" -Raw -Encoding UTF8
[xml]$ra3 = Get-Content -LiteralPath "$m3\About\About.xml" -Raw -Encoding UTF8
Write-Host ("  packageId: {0}" -f $ra3.ModMetaData.packageId)
$newRec = $r3.Patch.Operation.value.RecipeDef
Write-Host ("  adds recipe: {0}  (ParentName={1})" -f $newRec.defName, $newRec.ParentName)

if ($newRec.defName -eq 'MakeShell_AntigrainWarhead') { Ok 'defName matches exactly what CE asks for' } else { Bad ("defName is {0}" -f $newRec.defName) }

# parent must exist
$x = Test-Xpath $ceBases ('Defs/RecipeDef[@Name="{0}"]' -f $newRec.ParentName)
if ($x -eq 1) { Ok ("parent {0} exists in CE" -f $newRec.ParentName) } else { Bad ("parent {0} not found" -f $newRec.ParentName) }

# product must exist, and the name must not already be taken
$tMortar = Get-Content -LiteralPath $ceMortar -Raw -Encoding UTF8
$prod = @($newRec.products.ChildNodes | Where-Object { $_.Name -ne '#comment' })[0].Name
if ($tMortar.Contains("<defName>$prod</defName>")) { Ok ("product {0} exists in CE" -f $prod) } else { Bad ("product {0} not found" -f $prod) }
if ($tMortar.Contains('<defName>MakeShell_AntigrainWarhead</defName>')) { Bad 'CE already defines this recipe; adding it would duplicate' }
else { Ok 'CE does not define this recipe, so adding it is safe' }

# every ingredient must exist
foreach ($ing in $newRec.ingredients.li) {
  $def = $ing.filter.thingDefs.li
  $hit = Get-ChildItem -LiteralPath $baseData -Recurse -File -Filter '*.xml' -ErrorAction SilentlyContinue |
    Select-String -Pattern ("<defName>{0}</defName>" -f $def) -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { Ok ("ingredient {0} exists in base game" -f $def) } else { Bad ("ingredient {0} not found" -f $def) }
}

# the ModExtension class must exist in CE
$ceDll = $CeDll
$bytes = [IO.File]::ReadAllBytes($ceDll)
$needle = [Text.Encoding]::UTF8.GetBytes('GenericLabelExtension')
$found = $false
for ($i = 0; $i -le $bytes.Length - $needle.Length; $i++) {
  if ($bytes[$i] -eq $needle[0]) {
    $ok = $true
    for ($j = 1; $j -lt $needle.Length; $j++) { if ($bytes[$i + $j] -ne $needle[$j]) { $ok = $false; break } }
    if ($ok) { $found = $true; break }
  }
}
if ($found) { Ok 'GenericLabelExtension exists in CombatExtended.dll' } else { Bad 'GenericLabelExtension not found in CE assembly' }

Write-Host ''
if ($problems -eq 0) { Write-Host 'ALL CHECKS PASSED' } else { Write-Host ("{0} PROBLEM(S)" -f $problems); exit 1 }
