# Verify the compiled compression-guard assembly.
#
# ASCII only; paths arrive as parameters.
param(
  [Parameter(Mandatory = $true)][string]$Dll,
  [Parameter(Mandatory = $true)][string]$Managed,
  [Parameter(Mandatory = $true)][string]$HarmonyDll,
  [Parameter(Mandatory = $true)][string]$ModDll
)
$ErrorActionPreference = 'Stop'
$problems = 0
function Ok($m)  { Write-Host ('  ok   ' + $m) }
function Bad($m) { Write-Host ('  FAIL ' + $m); $script:problems++ }

# Pre-load the game assemblies so attributes that live in Assembly-CSharp (such as
# StaticConstructorOnStartup) resolve while reading this assembly's metadata.
foreach ($p in @(
    (Join-Path $Managed 'Assembly-CSharp.dll'),
    (Join-Path $Managed 'UnityEngine.CoreModule.dll'),
    (Join-Path $Managed 'UnityEngine.dll'),
    (Join-Path $Managed 'netstandard.dll'),
    $HarmonyDll
  )) {
  if (Test-Path $p) { try { [void][Reflection.Assembly]::Load([IO.File]::ReadAllBytes($p)) } catch { } }
}

function Test-Needle($bytes, $b) {
  for ($i = 0; $i -le $bytes.Length - $b.Length; $i++) {
    if ($bytes[$i] -ne $b[0]) { continue }
    $ok = $true
    for ($j = 1; $j -lt $b.Length; $j++) { if ($bytes[$i + $j] -ne $b[$j]) { $ok = $false; break } }
    if ($ok) { return $true }
  }
  return $false
}

# .NET stores string literals in the #US heap as UTF-16LE, while metadata names are UTF-8. Try both,
# otherwise a perfectly good assembly looks like it is missing its own string constants.
function Has-Utf8($bytes, [string]$text) {
  if (Test-Needle $bytes ([Text.Encoding]::UTF8.GetBytes($text))) { return $true }
  if (Test-Needle $bytes ([Text.Encoding]::Unicode.GetBytes($text))) { return $true }
  return $false
}

# Mod assemblies were compiled against whichever Assembly-CSharp version existed then, while this
# machine has the installed one. Outside the game there is no assembly binding redirect, so resolve
# any requested Assembly-CSharp to the loaded copy instead of failing with FileNotFoundException.
$script:ManagedDir = $Managed
[System.AppDomain]::CurrentDomain.add_AssemblyResolve({
    param($sender, $args)
    $simple = ($args.Name -split ',')[0]
    if ($simple -eq 'Assembly-CSharp' -or $simple -eq 'Assembly-CSharp-firstpass') {
      $p = Join-Path $script:ManagedDir 'Assembly-CSharp.dll'
      if (Test-Path $p) { return [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($p)) }
    }
    return $null
  })
function Get-AttrNames($member) {
  $names = @()
  try { foreach ($a in $member.GetCustomAttributes($false)) { $names += $a.GetType().Name } } catch { $names += '<unresolvable>' }
  return $names
}

Write-Host '=== 1. my assembly ==='
$asm = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($Dll))
Ok ("assembly {0}" -f $asm.GetName().Name)
$types = @()
try { $types = $asm.GetTypes() } catch [Reflection.ReflectionTypeLoadException] { $types = @($_.Exception.Types | Where-Object { $_ }) }
Ok ("{0} types" -f $types.Count)
foreach ($t in $types | Sort-Object FullName) { Write-Host ("         {0}" -f $t.FullName) }
foreach ($want in @('RimWorldCompressionFix.Bootstrap', 'RimWorldCompressionFix.Patch_CustomLoad')) {
  if ($types | Where-Object { $_.FullName -eq $want }) { Ok ("type present: {0}" -f $want) } else { Bad ("type missing: {0}" -f $want) }
}

Write-Host ''
Write-Host '=== 2. Harmony attributes ==='
$bootstrap = $types | Where-Object { $_.FullName -eq 'RimWorldCompressionFix.Bootstrap' } | Select-Object -First 1
$patchType = $types | Where-Object { $_.FullName -eq 'RimWorldCompressionFix.Patch_CustomLoad' } | Select-Object -First 1

if ($bootstrap) {
  $a = Get-AttrNames $bootstrap
  Write-Host ("  Bootstrap: [{0}]" -f ($a -join ', '))
  if ($a -contains 'StaticConstructorOnStartup') { Ok 'StaticConstructorOnStartup present (runs on game start)' } else { Bad 'StaticConstructorOnStartup missing - the patch would never apply' }
}
if ($patchType) {
  $a = Get-AttrNames $patchType
  Write-Host ("  Patch_CustomLoad: [{0}]" -f ($a -join ', '))
  if ($a -contains 'HarmonyPatch') { Ok 'HarmonyPatch present' } else { Bad 'HarmonyPatch missing' }
  foreach ($m in $patchType.GetMethods([Reflection.BindingFlags]'Public,NonPublic,Static,DeclaredOnly')) {
    $ma = Get-AttrNames $m
    if ($ma.Count -gt 0) { Write-Host ("      {0} : [{1}]" -f $m.Name, ($ma -join ', ')) }
  }
  $prep = $patchType.GetMethod('Prepare', [Reflection.BindingFlags]'Public,NonPublic,Static')
  $prepAttrs = if ($prep) { Get-AttrNames $prep } else { @() }
  if ($prepAttrs -contains 'HarmonyPrepare') { Ok 'Prepare carries HarmonyPrepare' } else { Bad 'Prepare is missing HarmonyPrepare' }
  $pre = $patchType.GetMethod('Prefix', [Reflection.BindingFlags]'Public,NonPublic,Static')
  $preAttrs = if ($pre) { Get-AttrNames $pre } else { @() }
  if ($preAttrs -contains 'HarmonyPrefix') { Ok 'Prefix carries HarmonyPrefix' } else { Bad 'Prefix is missing HarmonyPrefix' }
}

Write-Host ''
Write-Host '=== 3. the runtime lookup string vs the real target ==='
$raw = [IO.File]::ReadAllBytes($Dll)
$lookup = 'GraphicSetter.Patches.TextureLoadingPatch+LoadTexture_Patch:CustomLoad'
if (Has-Utf8 $raw $lookup) { Ok 'my assembly embeds the exact lookup string' } else { Bad 'lookup string not found in my assembly' }

$modTypes = @()
if (Test-Path $ModDll) {
  $mod = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($ModDll))
  try { $modTypes = $mod.GetTypes() } catch [Reflection.ReflectionTypeLoadException] { $modTypes = @($_.Exception.Types | Where-Object { $_ }) }
}
$target = $modTypes | Where-Object { $_.FullName -eq 'GraphicSetter.Patches.TextureLoadingPatch+LoadTexture_Patch' } | Select-Object -First 1
if ($target) {
  Ok 'the target type exists in GraphicSetter.dll'
  $cm = $target.GetMethod('CustomLoad', [Reflection.BindingFlags]'Public,NonPublic,Static,Instance')
  if ($cm) {
    Ok ("CustomLoad resolves: static={0} params=({1})" -f $cm.IsStatic, (($cm.GetParameters() | ForEach-Object { $_.ParameterType.Name + ' ' + $_.Name }) -join ', '))
    if ($cm.IsStatic) { Ok 'it is static, so Invoke(null, args) is correct' } else { Bad 'it is not static' }
    if ($cm.GetParameters().Count -eq 2) { Ok 'two parameters, so the invoke argument array is the right length' } else { Bad ("{0} parameters, expected 2" -f $cm.GetParameters().Count) }
  } else { Bad 'CustomLoad not found on that type' }
} else {
  Bad 'target type not found in GraphicSetter.dll'
}

Write-Host ''
Write-Host '=== 4. APIs the patch calls ==='
foreach ($s in @('Prefs', 'TextureCompression', 'Compress', 'Apply', 'mipMapBias', 'filterMode', 'anisoLevel', 'GraphicSetter.GraphicsSettings', 'mainSettings')) {
  if (Has-Utf8 $raw $s) { Ok ("references {0}" -f $s) } else { Bad ("does not reference {0}" -f $s) }
}

Write-Host ''
Write-Host '=== 5. the game assemblies really carry those members ==='
$csPath = Join-Path $Managed 'Assembly-CSharp.dll'
if (Has-Utf8 ([IO.File]::ReadAllBytes($csPath)) 'TextureCompression') { Ok 'Assembly-CSharp defines TextureCompression' } else { Bad 'TextureCompression absent from Assembly-CSharp' }
$core = [IO.File]::ReadAllBytes((Join-Path $Managed 'UnityEngine.CoreModule.dll'))
foreach ($m in @('Compress', 'Apply', 'mipMapBias')) {
  if (Has-Utf8 $core $m) { Ok ("CoreModule defines {0}" -f $m) } else { Bad ("CoreModule lacks {0}" -f $m) }
}

Write-Host ''
if ($problems -eq 0) { Write-Host 'ALL CHECKS PASSED' } else { Write-Host ("{0} PROBLEM(S)" -f $problems); exit 1 }
