# Simulate RimWorld patch operations against a COPY of the target file, faithfully enough to catch
# the mistakes that actually happen.
#
# Written after a real failure: a PatchOperationReplace whose <value> held bare text instead of the
# element being replaced passed the old probe, because that probe assigned InnerText and produced
# valid output either way. The game rejected it with
#   XML error: <text> doesn't correspond to any field in type X
# so this version replaces the whole node with the <value> element's children, which is what the
# loader does, and reports when <value> is bare text.
#
# The xpath is read OUT of the patch XML rather than passed on a command line, because a command line
# strips the quotes and silently corrupts the expression.
#
# ASCII only; paths arrive as parameters.
param(
  [Parameter(Mandatory = $true)][string]$PatchFile,
  [Parameter(Mandatory = $true)][string]$Target
)
$ErrorActionPreference = 'Stop'

[xml]$patch = Get-Content -LiteralPath $PatchFile -Raw -Encoding UTF8
$doc = New-Object System.Xml.XmlDocument
$doc.PreserveWhitespace = $true
$doc.Load($Target)

Write-Host "patch : $PatchFile"
Write-Host "target: $Target"

$problems = 0

function Apply-Value($node, $valueNode, $indent) {
  if ($valueNode -eq $null -or -not $valueNode.HasChildNodes) {
    Write-Host "$indent  value: (empty)"
    return
  }
  # A bare-text <value> means the patch will hand the loader a string where it expects an element.
  $onlyText = $true
  foreach ($c in $valueNode.ChildNodes) {
    if ($c.NodeType -eq 'Element') { $onlyText = $false; break }
  }
  if ($onlyText) {
    Write-Host "$indent  value is BARE TEXT: '$($valueNode.InnerText)'"
    Write-Host "$indent  -> if the target node is an element, the game will report"
    Write-Host "$indent     'XML error: <text> doesn't correspond to any field in type ...'"
    Write-Host "$indent     wrap it: <value><name>text</name></value>"
    $script:problems++
    return
  }

  # Replace the node with the value's children, mirroring the loader.
  $parent = $node.ParentNode
  foreach ($child in @($valueNode.ChildNodes)) {
    $imported = $doc.ImportNode($child, $true)
    [void]$parent.InsertBefore($imported, $node)
  }
  [void]$parent.RemoveChild($node)
  $rebuilt = ($valueNode.ChildNodes | ForEach-Object { $_.OuterXml }) -join ''
  Write-Host "$indent  replaced with: $rebuilt"
}

function Visit($node) {
  foreach ($child in $node.ChildNodes) {
    if ($child.NodeType -ne 'Element') { continue }
    if ($child.LocalName -eq 'Operation' -or $child.LocalName -eq 'li') {
      $xp = $child.SelectSingleNode('xpath')
      if ($xp) {
        $expr = $xp.InnerText
        $val = $child.SelectSingleNode('value')
        Write-Host ""
        Write-Host "  xpath  : $expr"
        $nodes = $doc.SelectNodes($expr)
        Write-Host "  matched: $($nodes.Count)"
        if ($nodes.Count -eq 0) {
          Write-Host "  -> would be SKIPPED silently in game"
        } else {
          foreach ($n in @($nodes)) {
            $before = $n.OuterXml
            Write-Host "  before : $before"
            Apply-Value $n $val "  "
          }
        }
      }
    }
    Visit $child
  }
}
Visit $patch.DocumentElement

Write-Host ""
Write-Host "resulting document: $($doc.OuterXml.Length) chars"
Write-Host "suspicious operations: $problems"
if ($problems -gt 0) { exit 1 }
