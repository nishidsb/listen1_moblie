import React from 'react';
import { View, ScrollView, ActivityIndicator, AsyncStorage } from 'react-native';
import styled, { withTheme } from 'styled-components';
import { getLyrics, hasLyrics } from '../../api/lyric';

// Bounded height so it never fights PlayerInfo (flex:1) for vertical space.
const Container = styled.View`
  height: 170;
  margin-top: 8;
  align-self: stretch;
  align-items: center;
  justify-content: flex-start;
`;

const ScrollWrap = styled(ScrollView)`
  flex: 1;
  align-self: stretch;
`;

const Line = styled(View)`
  padding-vertical: 6;
  padding-horizontal: 8;
  border-radius: 6;
`;

const Origin = styled.Text`
  font-size: ${(props) => (props.active ? 17 : 15)};
  font-weight: ${(props) => (props.active ? 'bold' : 'normal')};
  color: ${(props) => (props.active ? props.theme.primaryColor : props.theme.secondaryColor)};
  text-align: center;
`;

const Sub = styled.Text`
  font-size: 12;
  margin-top: ${(props) => (props.active ? 3 : 1)};
  color: ${(props) => props.theme.secondaryColor};
  opacity: ${(props) => (props.active ? 0.95 : 0.55)};
  text-align: center;
`;

const Tip = styled.Text`
  margin-top: 8;
  font-size: 13;
  color: ${(props) => props.theme.secondaryColor};
  opacity: 0.7;
  text-align: center;
`;

// Find the last line whose time <= current time (lyric time is shifted by
// the per-track calibration offset).
function resolveActiveIndex(lines, current, offset) {
  const at = (current || 0) + (offset || 0);
  let idx = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].time <= at + 0.05) {
      idx = i;
    } else {
      break;
    }
  }
  return idx;
}

class Lyrics extends React.PureComponent {
  props: {
    track: Object,
    current: Number,
    theme: Object,
  };
  constructor(props) {
    super(props);
    this.state = {
      lines: [],
      found: false,
      loading: false,
      noLyricTag: '',
      offset: 0,
    };
    this.scrollRef = React.createRef();
    // Guards against setState on unmounted component and stale responses.
    this.requestSeq = 0;
    this.lastScrolledIndex = -1;
    // Measured y offset of each rendered line (rows are variable height:
    // origin + translation + romaji), used for accurate auto-scrolling.
    this.lineY = [];
  }

  componentDidMount() {
    this.loadLyrics(this.props.track);
  }

  componentWillReceiveProps(nextProps) {
    if (nextProps.track !== this.props.track) {
      this.loadLyrics(nextProps.track);
    }
  }

  componentWillUnmount() {
    this.requestSeq += 1;
  }

  onLineLayout = (index, event) => {
    this.lineY[index] = event.nativeEvent.layout.y;
  };

  loadLyrics(track) {
    const seq = this.requestSeq + 1;
    this.requestSeq = seq;
    this.lastScrolledIndex = -1;
    this.lineY = [];

    if (!track || !track.title) {
      this.setState({ lines: [], found: false, loading: false, noLyricTag: '请选择歌曲', offset: 0 });
      return;
    }
    this.setState({ loading: true, lines: [], found: false, noLyricTag: '' });
    AsyncStorage.getItem(`lyric_offset_${track.id}`)
      .then((s) => {
        const offset = s ? parseFloat(s) || 0 : 0;
        if (seq !== this.requestSeq) return;
        this.setState({ offset });
      })
      .catch(() => undefined);
    getLyrics(track).then((res) => {
      if (seq !== this.requestSeq) {
        return; // a newer track was selected meanwhile
      }
      if (!hasLyrics(res)) {
        this.setState({ loading: false, lines: [], found: false, noLyricTag: '暂无歌词' });
        return;
      }
      this.setState({ loading: false, lines: res.lines, found: true });
    });
  }

  // Per-track calibration: shift lyric timing for cases where the matched
  // version differs from the playing audio (covers / clipped uploads).
  adjustOffset = (delta) => {
    const { track } = this.props;
    if (!track || !track.id) {
      return;
    }
    const next = Math.max(-15, Math.min(15, (this.state.offset || 0) + delta));
    this.setState({ offset: next });
    AsyncStorage.setItem(`lyric_offset_${track.id}`, String(next)).catch(() => undefined);
    this.lastScrolledIndex = -1;
  };

  scrollToActive(index) {
    if (!this.scrollRef.current) {
      return;
    }
    // Only scroll when the highlighted line actually changes.
    if (index === this.lastScrolledIndex) {
      return;
    }
    this.lastScrolledIndex = index;
    // Prefer the measured position (rows vary in height); fall back to a
    // row-height estimate before the first layout pass completes.
    const measured = this.lineY[index];
    const y = measured !== undefined
      ? Math.max(0, measured - 60)
      : Math.max(0, index * 36 - 70);
    this.scrollRef.current.scrollTo({ y, animated: true });
  }

  componentDidUpdate(prevProps, prevState) {
    if (
      this.state.lines.length &&
      (this.props.current !== prevProps.current ||
        prevState.offset !== this.state.offset)
    ) {
      const idx = resolveActiveIndex(this.state.lines, this.props.current, this.state.offset);
      this.scrollToActive(idx);
    }
  }

  render() {
    const { track, current, theme } = this.props;
    const { lines, found, loading, noLyricTag, offset } = this.state;
    const noTrack = track === null;

    if (loading) {
      return (
        <Container>
          <ActivityIndicator size="small" color={theme.primaryColor} />
        </Container>
      );
    }

    if (!found) {
      return (
        <Container>
          <Tip>{noTrack ? '请选择歌曲' : noLyricTag || '暂无歌词'}</Tip>
        </Container>
      );
    }

    const idx = resolveActiveIndex(lines, current, offset);

    return (
      <Container>
        <CalibRow>
          <CalibBtn onPress={() => this.adjustOffset(-0.5)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
            <CalibText theme={theme}>词快 0.5s</CalibText>
          </CalibBtn>
          <CalibLabel theme={theme}>
            {offset ? `${offset > 0 ? '+' : ''}${offset.toFixed(1)}s` : '校准'}
          </CalibLabel>
          <CalibBtn onPress={() => this.adjustOffset(0.5)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
            <CalibText theme={theme}>词慢 0.5s</CalibText>
          </CalibBtn>
        </CalibRow>
        <ScrollWrap ref={this.scrollRef}>
          <View style={{ paddingBottom: 100 }}>
            {lines.map((line, i) => {
              const active = i === idx;
              return (
                <Line
                  key={`${line.time}-${i}`}
                  onLayout={(event) => this.onLineLayout(i, event)}
                >
                  <Origin active={active} theme={theme}>
                    {line.text}
                  </Origin>
                  {line.trans ? (
                    <Sub active={active} theme={theme}>
                      {line.trans}
                    </Sub>
                  ) : null}
                  {line.roma ? (
                    <Sub active={active} theme={theme}>
                      {line.roma}
                    </Sub>
                  ) : null}
                </Line>
              );
            })}
          </View>
        </ScrollWrap>
      </Container>
    );
  }
}

const CalibRow = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: center;
  padding-horizontal: 8;
`;
const CalibBtn = styled.TouchableOpacity`
  padding-horizontal: 6;
`;
const CalibText = styled.Text`
  font-size: 11;
  color: ${(props) => props.theme.secondaryColor};
`;
const CalibLabel = styled.Text`
  font-size: 11;
  min-width: 48;
  text-align: center;
  color: ${(props) => props.theme.secondaryColor};
`;

export default withTheme(Lyrics);
